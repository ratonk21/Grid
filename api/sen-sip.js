// api/sen-sip.js
// Proxy seguro para API pública/operacional del Coordinador Eléctrico Nacional.
// Mantiene la SIP_USER_KEY y credenciales OAuth sólo en el servidor (Vercel).
// Esta versión permite pasar parámetros adicionales del SIP (limit, pageSize,
// tipoTecnologia, idCentral, date, yearMonth, etc.) sin exponer user_key.

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
  if (!r.ok) throw new Error("token_error_" + r.status);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: now + (Number(j.expires_in || 300) * 1000) };
  return tokenCache.token;
}

function cleanPath(p) {
  return String(p || "").replace(/^https?:\/\/[^/]+/i, "").replace(/\.\.+/g, "").replace(/^\/+/, "");
}

function safeSegment(v, rx, fallback) {
  const s = String(v || fallback || "");
  return s.replace(rx, "");
}

function copyParams(q, deny = []) {
  const denySet = new Set(["recurso", "version", "metodo", "mode", "path", "ping", "user_key", ...deny]);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(q || {})) {
    if (denySet.has(k)) continue;
    if (v == null || v === "") continue;
    out.set(k, Array.isArray(v) ? v[0] : String(v));
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const q = req.query || {};
  if (q.ping !== undefined) return res.status(200).json({ ok: true, service: "sen-sip", version: "v2" });
  if (!originOk(req)) return res.status(403).json({ error: "forbidden_origin" });

  const mode = (q.mode === "op" || q.mode === "operacional") ? "op" : "public";

  try {
    if (mode === "op") {
      const base = process.env.SIP_OP_BASE;
      if (!base) return res.status(500).json({ error: "missing_op_base" });
      const path = cleanPath(q.path);
      if (!path) return res.status(400).json({ error: "missing_path" });
      const token = await getOpToken();
      const params = copyParams(q);
      const url = `${base.replace(/\/+$/, "")}/${path}${params.toString() ? "?" + params.toString() : ""}`;
      const r = await fetch(url, { headers: { accept: "application/json", Authorization: `Bearer ${token}` } });
      const ctype = r.headers.get("content-type") || "";
      if (!ctype.includes("json")) return res.status(r.status).json({ error: "non_json_response", http: r.status, preview: (await r.text()).slice(0, 200) });
      const data = await r.json();
      return res.status(r.status).json({ _meta: { mode: "op", path }, ...(Array.isArray(data) ? { results: data } : data) });
    }

    const userKey = process.env.SIP_USER_KEY;
    if (!userKey) return res.status(500).json({ error: "missing_user_key" });
    const recurso = safeSegment(q.recurso, /[^a-z0-9_-]/gi, process.env.SIP_RECURSO || "costo-marginal-real");
    const version = safeSegment(q.version, /[^a-z0-9]/gi, process.env.SIP_VERSION || "v4");
    const metodo = safeSegment(q.metodo, /[^a-zA-Z]/g, process.env.SIP_METODO || "findByDate");
    const params = copyParams(q);
    params.set("user_key", userKey);

    if (metodo.toLowerCase().includes("findbydate") && !params.get("startDate") && !params.get("endDate")) {
      return res.status(400).json({ error: "missing_dates" });
    }

    const url = `${SIP_PUB_BASE}/${recurso}/${version}/${metodo}?${params.toString()}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("json")) return res.status(r.status).json({ error: "non_json_response", recurso, version, metodo, http: r.status, preview: (await r.text()).slice(0, 200) });
    const data = await r.json();
    return res.status(r.status).json({ _meta: { mode: "public", recurso, version, metodo, rateRemaining: r.headers.get("x-rate-limit-remaining") }, ...data });
  } catch (e) {
    console.error("sen-sip fatal", e);
    if (String(e.message || "").startsWith("token_error")) return res.status(502).json({ error: "token_error" });
    return res.status(502).json({ error: e.message || "upstream_error" });
  }
}
