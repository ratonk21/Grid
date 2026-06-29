// api/sen-sip.js
// Conector de datos del analizador SEN → API del Coordinador Eléctrico Nacional.
// Soporta los DOS esquemas del manual oficial:
//
//   MODO PÚBLICO  (planes "Activo")      → auth por user_key en la URL
//     https://sipub.api.coordinador.cl/{recurso}/{version}/findAll
//       ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&page=0&user_key=XXXX
//
//   MODO OPERACIONAL (planes "Pendiente") → OAuth2 client_credentials (Keycloak)
//     1) POST token  https://security-access-api.coordinador.cl/auth/realms/API-MANAGER/protocol/openid-connect/token
//        (client_id, client_secret, grant_type=client_credentials)
//     2) GET  {SIP_OP_BASE}/{path}   con  Authorization: Bearer <token>
//
// Como el resto de griddata.cl: secretos SOLO en el server; el front manda el
// código en x-access-code; mismo patrón OAuth que api/control.js.
//
// Variables de entorno (Vercel · Production):
//   SEN_ACCESS_CODE     -> gate (x-access-code), el mismo del front de optimo-SEN
//   --- modo público ---
//   SIP_USER_KEY        -> tu user_key de portal.api.coordinador.cl
//   SIP_RECURSO         -> opcional, default "costo-marginal-real"
//   SIP_VERSION         -> opcional, default "v4"
//   --- modo operacional ---
//   SIP_CLIENT_ID       -> clientID de la aplicación (detalle de tu plan)
//   SIP_CLIENT_SECRET   -> Clave Secreta del Cliente
//   SIP_OP_BASE         -> base del servicio operacional
//                          (p.ej. https://mercados.api.coordinador.cl ; el manual
//                           muestra el de staging mercados-stage.api.coordinador.cl)

import crypto from "node:crypto";

const SIP_PUB_BASE = "https://sipub.api.coordinador.cl";
const TOKEN_URL = "https://security-access-api.coordinador.cl/auth/realms/API-MANAGER/protocol/openid-connect/token";

function codeOk(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Caché simple de token OAuth en memoria de la función (se reusa entre llamadas calientes).
let tokenCache = { token: null, exp: 0 };

async function getOpToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp - 15000) return tokenCache.token;
  const id = process.env.SIP_CLIENT_ID, secret = process.env.SIP_CLIENT_SECRET;
  if (!id || !secret) throw new Error("missing_oauth_credentials");
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("token_error_" + r.status + ":" + t.slice(0, 120)); }
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: now + (Number(j.expires_in || 300) * 1000) };
  return tokenCache.token;
}

// Sanea una ruta operacional: solo relativa, sin esquema/host, sin traversal.
function cleanPath(p) {
  return String(p || "")
    .replace(/^https?:\/\/[^/]+/i, "")  // quita esquema+host si lo pegaron entero
    .replace(/\.\.+/g, "")              // sin traversal
    .replace(/^\/+/, "");               // sin barra inicial
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};

  // Health check (sin código).
  if (q.ping !== undefined) {
    return res.status(200).json({
      ok: true, service: "sen-sip", needsCode: true,
      modes: { publico: !!process.env.SIP_USER_KEY, operacional: !!(process.env.SIP_CLIENT_ID && process.env.SIP_CLIENT_SECRET) }
    });
  }

  const accessCode = process.env.SEN_ACCESS_CODE;
  if (!accessCode) return res.status(500).json({ error: "server_misconfigured" });
  if (!codeOk(req.headers["x-access-code"], accessCode)) return res.status(401).json({ error: "invalid_access_code" });

  const mode = (q.mode === "op" || q.mode === "operacional") ? "op" : "public";

  try {
    if (mode === "op") {
      // ---- Operacional: OAuth Bearer ----
      const base = process.env.SIP_OP_BASE;
      if (!base) return res.status(500).json({ error: "missing_op_base", hint: "Define SIP_OP_BASE (base del servicio operacional)." });
      const path = cleanPath(q.path);
      if (!path) return res.status(400).json({ error: "missing_path", hint: "En modo operacional indica 'path' (p.ej. client-supplier/findbyrut?rut=13016438-2)." });

      const token = await getOpToken();
      const url = `${base.replace(/\/+$/, "")}/${path}`;
      const r = await fetch(url, { headers: { accept: "application/json", Authorization: `Bearer ${token}` } });
      const ctype = r.headers.get("content-type") || "";
      if (!ctype.includes("json")) {
        const txt = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "non_json_response", http: r.status, path, preview: txt.slice(0, 200) });
      }
      const data = await r.json();
      return res.status(r.status).json({ _meta: { mode: "op", path }, ...(Array.isArray(data) ? { results: data } : data) });
    }

    // ---- Público: user_key ----
    const userKey = process.env.SIP_USER_KEY;
    if (!userKey) return res.status(500).json({ error: "missing_user_key", hint: "Define SIP_USER_KEY o usa mode=op." });
    const recurso = String(q.recurso || process.env.SIP_RECURSO || "costo-marginal-real").replace(/[^a-z0-9_-]/gi, "");
    const version = String(q.version || process.env.SIP_VERSION || "v4").replace(/[^a-z0-9]/gi, "");
    const metodo  = String(q.metodo  || process.env.SIP_METODO  || "findByDate").replace(/[^a-zA-Z]/g, "");
    const startDate = q.startDate, endDate = q.endDate;
    const page = Number(q.page || 0);
    if (!startDate || !endDate) return res.status(400).json({ error: "missing_dates", hint: "startDate y endDate (YYYY-MM-DD)" });

    const url = `${SIP_PUB_BASE}/${recurso}/${version}/${metodo}`
      + `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&page=${page}&user_key=${encodeURIComponent(userKey)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("json")) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "non_json_response", hint: "Revisa recurso/versión/método contra tu documentación del SIP.", recurso, version, metodo, http: r.status, preview: txt.slice(0, 200) });
    }
    const data = await r.json();
    return res.status(r.status).json({
      _meta: { mode: "public", recurso, version, metodo, rateRemaining: r.headers.get("x-rate-limit-remaining"), rateLimit: r.headers.get("x-rate-limit") },
      ...data
    });
  } catch (e) {
    console.error("sen-sip fatal", e);
    const msg = e.message || "upstream_error";
    if (msg.startsWith("token_error")) return res.status(502).json({ error: "token_error", detail: msg });
    if (msg === "missing_oauth_credentials") return res.status(500).json({ error: "missing_oauth_credentials", hint: "Define SIP_CLIENT_ID y SIP_CLIENT_SECRET." });
    return res.status(502).json({ error: "upstream_error", detail: msg });
  }
}
