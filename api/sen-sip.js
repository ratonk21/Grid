// api/sen-sip.js
// Conector de datos del analizador SEN → API del Coordinador Eléctrico Nacional.
// Plataforma de cara al cliente: el front llama sin código; la user_key vive
// SOLO aquí y el acceso se restringe por ORIGEN (dominio).
//
//   MODO PÚBLICO  (planes "Activo")      → auth por user_key en la URL
//     https://sipub.api.coordinador.cl/{recurso}/{version}/{metodo}
//       ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&page=0&user_key=XXXX
//   MODO OPERACIONAL (planes "Pendiente") → OAuth2 client_credentials (Keycloak)
//
// Variables de entorno (Vercel · Production):
//   SIP_USER_KEY         -> user_key de portal.api.coordinador.cl (modo público)
// Opcional:
//   SEN_ALLOWED_ORIGINS  -> orígenes permitidos (ej. "https://griddata.cl,https://www.griddata.cl")
//   SIP_RECURSO / SIP_VERSION / SIP_METODO   -> defaults del recurso público
//   SIP_CLIENT_ID / SIP_CLIENT_SECRET / SIP_OP_BASE  -> modo operacional (OAuth)

const SIP_PUB_BASE = "https://sipub.api.coordinador.cl";
const TOKEN_URL = "https://security-access-api.coordinador.cl/auth/realms/API-MANAGER/protocol/openid-connect/token";

function originOk(req) {
  const allow = (process.env.SEN_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const o = req.headers.origin || "";
  const ref = req.headers.referer || "";
  return allow.some(a => o === a || ref.startsWith(a));
}

let tokenCache = { token: null, exp: 0 };
async function getOpToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp - 15000) return tokenCache.token;
  const id = process.env.SIP_CLIENT_ID, secret = process.env.SIP_CLIENT_SECRET;
  if (!id || !secret) throw new Error("missing_oauth_credentials");
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("token_error_" + r.status + ":" + t.slice(0, 120)); }
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: now + (Number(j.expires_in || 300) * 1000) };
  return tokenCache.token;
}

function cleanPath(p) {
  return String(p || "").replace(/^https?:\/\/[^/]+/i, "").replace(/\.\.+/g, "").replace(/^\/+/, "");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  if (q.ping !== undefined) {
    return res.status(200).json({ ok: true, service: "sen-sip" });
  }

  if (!originOk(req)) return res.status(403).json({ error: "forbidden_origin" });

  const mode = (q.mode === "op" || q.mode === "operacional") ? "op" : "public";

  try {
    if (mode === "op") {
      const base = process.env.SIP_OP_BASE;
      if (!base) return res.status(500).json({ error: "missing_op_base" });
      const path = cleanPath(q.path);
      if (!path) return res.status(400).json({ error: "missing_path" });
      const token = await getOpToken();
      const url = `${base.replace(/\/+$/, "")}/${path}`;
      const r = await fetch(url, { headers: { accept: "application/json", Authorization: `Bearer ${token}` } });
      const ctype = r.headers.get("content-type") || "";
      if (!ctype.includes("json")) { const txt = await r.text().catch(() => ""); return res.status(r.status).json({ error: "non_json_response", http: r.status, preview: txt.slice(0, 200) }); }
      const data = await r.json();
      return res.status(r.status).json({ _meta: { mode: "op", path }, ...(Array.isArray(data) ? { results: data } : data) });
    }

    const userKey = process.env.SIP_USER_KEY;
    if (!userKey) return res.status(500).json({ error: "missing_user_key" });
    const recurso = String(q.recurso || process.env.SIP_RECURSO || "costo-marginal-real").replace(/[^a-z0-9_-]/gi, "");
    const version = String(q.version || process.env.SIP_VERSION || "v4").replace(/[^a-z0-9]/gi, "");
    const metodo  = String(q.metodo  || process.env.SIP_METODO  || "findByDate").replace(/[^a-zA-Z]/g, "");
    const startDate = q.startDate, endDate = q.endDate;
    const page = Number(q.page || 0);
    if (!startDate || !endDate) return res.status(400).json({ error: "missing_dates" });

    const url = `${SIP_PUB_BASE}/${recurso}/${version}/${metodo}`
      + `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&page=${page}&user_key=${encodeURIComponent(userKey)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("json")) { const txt = await r.text().catch(() => ""); return res.status(r.status).json({ error: "non_json_response", recurso, version, metodo, http: r.status, preview: txt.slice(0, 200) }); }
    const data = await r.json();
    return res.status(r.status).json({
      _meta: { mode: "public", recurso, version, metodo, rateRemaining: r.headers.get("x-rate-limit-remaining") },
      ...data
    });
  } catch (e) {
    console.error("sen-sip fatal", e);
    const msg = e.message || "upstream_error";
    if (msg.startsWith("token_error")) return res.status(502).json({ error: "token_error" });
    if (msg === "missing_oauth_credentials") return res.status(500).json({ error: "missing_oauth_credentials" });
    return res.status(502).json({ error: "upstream_error" });
  }
}
