// api/sen-sip.js
// Conector de datos del analizador SEN: proxy a la API Pública SIP del
// Coordinador Eléctrico Nacional. La user_key vive SOLO aquí; el front manda el
// código en x-access-code (mismo patrón que el resto de griddata.cl).
//
// Patrón real de la API (doc del Coordinador, 2024):
//   https://sipub.api.coordinador.cl/{recurso}/{version}/findAll
//     ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&page=0&user_key=XXXX
//
// Variables de entorno (Vercel · Production):
//   SIP_USER_KEY     -> tu clave de portal.api.coordinador.cl  (secreto)
//   SEN_ACCESS_CODE  -> el mismo código del front de optimo-SEN (gate)
// Opcional (defaults según tu plan):
//   SIP_RECURSO      -> default "costo-marginal-real"
//   SIP_VERSION      -> default "v4"

import crypto from "node:crypto";

const SIP_BASE = "https://sipub.api.coordinador.cl";

function codeOk(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};

  // Health check (sin código): el front muestra "backend activo".
  if (q.ping !== undefined) {
    return res.status(200).json({ ok: true, service: "sen-sip", base: SIP_BASE, needsCode: true });
  }

  const userKey = process.env.SIP_USER_KEY;
  const accessCode = process.env.SEN_ACCESS_CODE;
  if (!userKey || !accessCode) return res.status(500).json({ error: "server_misconfigured" });

  if (!codeOk(req.headers["x-access-code"], accessCode)) {
    return res.status(401).json({ error: "invalid_access_code" });
  }

  const recurso = String(q.recurso || process.env.SIP_RECURSO || "costo-marginal-real").replace(/[^a-z0-9_-]/gi, "");
  const version = String(q.version || process.env.SIP_VERSION || "v4").replace(/[^a-z0-9]/gi, "");
  const startDate = q.startDate, endDate = q.endDate;
  const page = Number(q.page || 0);
  if (!startDate || !endDate) return res.status(400).json({ error: "missing_dates", hint: "startDate y endDate (YYYY-MM-DD)" });

  const url = `${SIP_BASE}/${recurso}/${version}/findAll`
    + `?startDate=${encodeURIComponent(startDate)}`
    + `&endDate=${encodeURIComponent(endDate)}`
    + `&page=${page}`
    + `&user_key=${encodeURIComponent(userKey)}`;

  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("json")) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({
        error: "non_json_response",
        hint: "Revisa el nombre del recurso/versión contra tu documentación del SIP.",
        recurso, version, http: r.status, preview: txt.slice(0, 200)
      });
    }
    const data = await r.json();
    return res.status(r.status).json({
      _meta: { recurso, version, rateRemaining: r.headers.get("x-rate-limit-remaining"), rateLimit: r.headers.get("x-rate-limit") },
      ...data
    });
  } catch (e) {
    console.error("sen-sip fatal", e);
    return res.status(502).json({ error: "upstream_error", detail: e.message });
  }
}
