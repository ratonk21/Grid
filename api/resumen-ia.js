// api/resumen-ia.js
// Proxy serverless cerrado para la "Interpretación IA" del comparador de ahorro.
// Mismo patrón que el resto de griddata.cl: el secreto (ANTHROPIC_API_KEY) vive
// SOLO aquí, nunca en el front. El front manda el código en x-access-code.
//
// Variables de entorno requeridas en Vercel (Project → Settings → Environment):
//   ANTHROPIC_API_KEY   -> tu API key de Anthropic (sk-ant-...)
//   IA_ACCESS_CODE      -> el código que pide el front (el mismo que escribes en el prompt)
// Opcional:
//   IA_MODEL            -> override del modelo (default: claude-sonnet-4-6)

import crypto from "node:crypto";

const MODEL = process.env.IA_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Comparación en tiempo (casi) constante para el código de acceso.
function codeOk(provided, expected) {
  if (!expected) return false;                 // si no está configurado, nadie pasa
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Lee el body venga como objeto, string o stream.
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function buildPrompt(p) {
  const cases = Array.isArray(p.cases) ? p.cases : [];
  const lineas = cases.map((c, i) =>
    `${i + 1}. ${c.name}: ${c.annualKwh} / ${c.annualUSD} al año · ahorro ${c.savUSD} (${c.savPct}) · payback ${c.payback}`
  ).join("\n");

  return [
    `Lugar: ${p.place || "—"} · Año de referencia: ${p.year || "—"}`,
    ``,
    `CASO BASE (referencia): ${p.base?.name || "—"} — consumo ${p.base?.annualKwh || "—"}, costo ${p.base?.annualUSD || "—"} al año.`,
    ``,
    `Banda de resultados entre los escenarios:`,
    `  Ahorro %: ${p.band?.pct || "—"}`,
    `  Ahorro USD/año: ${p.band?.usd || "—"}`,
    `  Payback: ${p.band?.pay || "—"}`,
    ``,
    `ESCENARIOS COMPARADOS (ordenados por ahorro):`,
    lineas || "  (sin casos)",
  ].join("\n");
}

function systemFor(lang) {
  if (lang === "en") {
    return [
      "You are a senior analyst of smart public-lighting telemanagement (Ubicquia platform).",
      "You receive the result of an energy-savings comparator between dimming scenarios.",
      "Write an EXECUTIVE interpretation IN ENGLISH, in plain text (no Markdown, no bullets, no bold or headings).",
      "Max 3 short paragraphs (≈150–200 words total). Use figures-with-meaning: state the number and what it means, do not list KPIs.",
      "Highlight the scenario with the best savings/payback ratio, name the main trade-off (savings vs. service level) and close with ONE actionable recommendation.",
      "Do not invent data that is not in the payload. If a value is missing, say so in one sentence, do not fill it in."
    ].join(" ");
  }
  return [
    "Eres un analista senior de telegestión de alumbrado público (plataforma Ubicquia).",
    "Recibes el resultado de un comparador de ahorro energético entre escenarios de dimerización.",
    "Escribe una interpretación EJECUTIVA EN ESPAÑOL, en texto plano (sin Markdown, sin viñetas, sin negritas ni títulos).",
    "Máximo 3 párrafos cortos (≈150–200 palabras en total). Usa cifras-con-significado: di el número y qué significa, no listes KPIs.",
    "Destaca el escenario con mejor relación ahorro/payback, nombra el trade-off principal (ahorro vs. nivel de servicio) y cierra con UNA recomendación accionable.",
    "No inventes datos que no estén en el payload. Si falta un dato, dilo en una frase, no rellenes."
  ].join(" ");
}

export default async function handler(req, res) {
  // CORS mínimo (mismo origen en producción; útil para pruebas locales).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // 1) Configuración del servidor.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const accessCode = process.env.IA_ACCESS_CODE;
  if (!apiKey || !accessCode) {
    return res.status(500).json({ error: "server_misconfigured" });
  }

  // 2) Puerta de acceso (devuelve 401 -> el front borra el código y lo vuelve a pedir).
  if (!codeOk(req.headers["x-access-code"], accessCode)) {
    return res.status(401).json({ error: "invalid_access_code" });
  }

  // 3) Payload del comparador.
  const payload = await readJson(req);
  if (!payload || !Array.isArray(payload.cases) || payload.cases.length === 0) {
    return res.status(400).json({ error: "no_cases" });
  }

  // 4) Llamada a Anthropic.
  const lang = payload.lang === "en" ? "en" : "es";
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemFor(lang),
        messages: [{ role: "user", content: buildPrompt(payload) }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("Anthropic error", r.status, detail.slice(0, 500));
      return res.status(502).json({ error: "upstream_error", status: r.status });
    }

    const data = await r.json();
    const text = (data?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) return res.status(502).json({ error: "empty_response" });

    return res.status(200).json({ text });
  } catch (e) {
    console.error("resumen-ia fatal", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
