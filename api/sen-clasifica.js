// api/sen-clasifica.js
// Conector IA del analizador SEN (optimo-SEN): clasifica el "motivo" de una
// limitación por contaminante y decreto. Mismo patrón que api/resumen-ia.js:
// el secreto (ANTHROPIC_API_KEY) vive SOLO aquí; el front manda el código en
// x-access-code. La clave NUNCA viaja al navegador.
//
// Variables de entorno (Vercel · Production):
//   ANTHROPIC_API_KEY   -> tu API key de Anthropic (sk-ant-...)   [compartida con el resto del sitio]
//   SEN_ACCESS_CODE     -> código que pide el front de optimo-SEN
// Opcional:
//   IA_MODEL            -> override del modelo (default: claude-sonnet-4-6)

import crypto from "node:crypto";

const MODEL = process.env.IA_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CONTAMS = ["Temp. Agua de Mar", "NOx", "MP", "SO2", "COx", "Otros"];

// Comparación en tiempo (casi) constante para el código de acceso.
function codeOk(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function buildPrompt(text) {
  return `Eres un analista del mercado eléctrico chileno. Clasifica el motivo de una limitación de una unidad generadora termoeléctrica del SEN según el contaminante ambiental y el decreto aplicable.

Categorías de contaminante (usa EXACTAMENTE una): ${CONTAMS.map(c => `"${c}"`).join(", ")}.
Decretos: "D.S. 90/2001" para temperatura/descarga de agua de mar (residuos líquidos); "D.S. 13/2011" para emisiones atmosféricas (NOx, MP, SO2, COx); "—" si es ambiguo (Otros).

Motivo: "${String(text).replace(/"/g, "'").slice(0, 1000)}"

Responde SOLO con JSON, sin texto adicional ni markdown:
{"cont":"<categoria>","dec":"<decreto>","conf":<0..1>,"why":"<una frase breve en español>"}`;
}

function safeParse(raw) {
  const txt = String(raw || "").replace(/```json|```/g, "").trim();
  try {
    const o = JSON.parse(txt);
    if (!CONTAMS.includes(o.cont)) o.cont = "Otros";
    return {
      cont: o.cont,
      dec: o.dec || "—",
      conf: Math.max(0, Math.min(1, Number(o.conf) || 0.5)),
      why: o.why || "—"
    };
  } catch {
    return { cont: "Otros", dec: "—", conf: 0.4, why: "No se pudo interpretar la respuesta del modelo." };
  }
}

async function classifyOne(apiKey, text) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: "user", content: buildPrompt(text) }] })
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("Anthropic error", r.status, detail.slice(0, 300));
    return { cont: "Otros", dec: "—", conf: 0, why: "Error Anthropic " + r.status };
  }
  const data = await r.json();
  const text2 = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return safeParse(text2);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Health check (sin código): permite al front mostrar "backend activo".
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "sen-clasifica", model: MODEL, needsCode: true });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const accessCode = process.env.SEN_ACCESS_CODE;
  if (!apiKey || !accessCode) return res.status(500).json({ error: "server_misconfigured" });

  if (!codeOk(req.headers["x-access-code"], accessCode)) {
    return res.status(401).json({ error: "invalid_access_code" });
  }

  const body = await readJson(req);
  const items = Array.isArray(body.texts) ? body.texts : (body.text != null ? [body.text] : null);
  if (!items || !items.length) return res.status(400).json({ error: "no_text" });

  try {
    const results = [];
    for (const t of items.slice(0, 50)) results.push(await classifyOne(apiKey, t));
    return res.status(200).json(Array.isArray(body.texts) ? { results } : results[0]);
  } catch (e) {
    console.error("sen-clasifica fatal", e);
    return res.status(502).json({ error: "upstream_error" });
  }
}
