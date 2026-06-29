// api/sen-extrae.js
// Extractor IA del analizador SEN (optimo-SEN). Recibe el TEXTO de una sección
// del Informe Diario del Coordinador (3.2 Limitación Forzada, 3.5 Restricción
// Operativa, 4.1 Observaciones o Justificación de desviaciones) y devuelve SOLO
// las limitaciones de causa AMBIENTAL, ya estructuradas y clasificadas por
// contaminante y decreto. Una sola llamada al modelo por sección (eficiente).
//
// El front extrae el texto del PDF en el navegador (PDF.js) y manda solo texto,
// así se evita el límite de tamaño de Vercel y no se sube el binario.
//
// Variables de entorno (Vercel · Production):
//   ANTHROPIC_API_KEY    -> API key de Anthropic (sk-ant-...)  [compartida con el sitio]
// Opcional:
//   SEN_ALLOWED_ORIGINS  -> orígenes permitidos separados por coma
//                           (ej. "https://griddata.cl,https://www.griddata.cl").
//                           Si no se define, el endpoint queda abierto.
//   IA_MODEL             -> override del modelo (default: claude-sonnet-4-6)

const MODEL = process.env.IA_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CONTAMS = ["Temp. Agua de Mar", "NOx", "MP", "SO2", "COx", "Otros"];
const MAX_TEXT = 14000; // recorte defensivo por sección

// Restricción por origen: protege la clave sin exponer un código en el front.
// Nota: Origin/Referer es falsificable por clientes que no son navegadores;
// para blindaje fuerte, sumar rate-limit (Vercel WAF) sobre este endpoint.
function originOk(req) {
  const allow = (process.env.SEN_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const o = req.headers.origin || "";
  const ref = req.headers.referer || "";
  return allow.some(a => o === a || ref.startsWith(a));
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function buildPrompt(text, fecha, seccion) {
  const t = String(text || "").slice(0, MAX_TEXT);
  return `Eres un analista del mercado eléctrico chileno experto en el Sistema Eléctrico Nacional (SEN) y en las restricciones ambientales que limitan la generación termoeléctrica.

Te entrego el texto de una sección del Informe Diario del Coordinador Eléctrico Nacional${seccion ? ` (sección: ${seccion})` : ""}${fecha ? `, del día ${fecha}` : ""}. Tu tarea es EXTRAER únicamente las limitaciones de generación cuya causa sea AMBIENTAL, es decir, motivadas por cumplimiento de normas de emisiones atmosféricas (D.S. 13/2011) o de descarga de agua de mar / residuos líquidos (D.S. 90/2001).

INCLUIR (causa ambiental) cuando el texto mencione, por ejemplo:
- Emisiones o abatimiento de SO2, NOx, MP (material particulado), CO/COx; sistemas SCR; control de emisiones.
- Cumplimiento de DS 13/2011, ciclaje persistente para cumplir DS13/2011, tiempos mínimos de operación por norma de emisiones.
- Límite de CO acumulado (ton/día) autorizado por la RCA (Resolución de Calificación Ambiental).
- Temperatura o descarga de agua de mar, residuos líquidos, DS 90/2001.

EXCLUIR (NO son ambientales): costo marginal, fallas mecánicas (válvulas, inyectores, turbinas, calderas, refrigeración, acoplamientos), AGC/CPF/CSF/CTF y control dinámico de tensión, control de potencia reactiva, indisponibilidad de gas argentino o de combustible, mantenimiento, pruebas de puesta en servicio, fallas de comunicación/SCADA/telecontrol, condiciones hidráulicas/riego/caudal, robos de conductor, control de transferencia de líneas.

Contaminante (usa EXACTAMENTE uno de): ${CONTAMS.map(c => `"${c}"`).join(", ")}.
Decreto: "D.S. 90/2001" para temperatura/descarga de agua de mar; "D.S. 13/2011" para emisiones atmosféricas (NOx, MP, SO2, COx); "—" si es ambiental pero ambiguo.

Para cada limitación ambiental detectada entrega:
- "central": nombre de la central o unidad tal como aparece (ej. "TER Guacolda 5", "TER San Isidro II Gas Arg", "TER Nehuenco 9B").
- "mw_limite": número en MW al que queda limitada si el texto lo indica (ej. 50), o null.
- "hora": hora del evento en formato HH:MM si aparece (típico en 4.1 Observaciones), o "".
- "motivo": frase breve en español con la causa (ej. "Anormalidad en el sistema de abatimiento de SO2").
- "cont": contaminante de la lista.
- "dec": decreto.

Ejemplos de extracción correcta (referencia, no los copies literalmente):
- "TER Guacolda 5 limitada a 50 MW. Causa: Anormalidad en el sistema de abatimiento de SO2" -> {"central":"TER Guacolda 5","mw_limite":50,"cont":"SO2","dec":"D.S. 13/2011"}
- "C. San Isidro II limitada a 300 MW por control de emisiones NOX y baja eficiencia del sistema SCR" -> {"central":"San Isidro II","mw_limite":300,"cont":"NOx","dec":"D.S. 13/2011"}
- "Para dar cumplimiento al DS13/2011 se actualizan los tiempos mínimos de operación en ciclaje persistente de Guacolda U3" -> {"central":"TER Guacolda U3","mw_limite":null,"cont":"Otros","dec":"D.S. 13/2011","motivo":"Ciclaje persistente para cumplir DS13/2011"} (contaminante no especificado = "Otros" pero SÍ es ambiental DS13)
- "Nehuenco 9B limitada a 95 MW por cumplir límite CO acumulado mayor a 0.5 ton/día según la RCA" -> {"central":"TER Nehuenco 9B","mw_limite":95,"cont":"COx","dec":"D.S. 13/2011"}

Si una central aparece varias veces con la misma causa ambiental, entrega una sola fila (la más representativa).
Si NO hay ninguna limitación ambiental en el texto, responde {"rows":[]}.

Texto de la sección:
"""
${t}
"""

Responde SOLO con JSON válido, sin markdown ni texto adicional, con esta forma exacta:
{"rows":[{"central":"...","mw_limite":<numero|null>,"hora":"...","motivo":"...","cont":"...","dec":"..."}]}`;
}

function safeParse(raw) {
  const txt = String(raw || "").replace(/```json|```/g, "").trim();
  let o;
  try { o = JSON.parse(txt); }
  catch {
    // intento de rescate: tomar el primer objeto {...} con "rows"
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  }
  const rows = (o && Array.isArray(o.rows)) ? o.rows : [];
  return rows.map(r => {
    let cont = CONTAMS.includes(r.cont) ? r.cont : "Otros";
    let dec = typeof r.dec === "string" && r.dec.trim() ? r.dec.trim() : "—";
    let mw = (r.mw_limite === null || r.mw_limite === undefined || r.mw_limite === "") ? null : Number(r.mw_limite);
    if (mw !== null && !isFinite(mw)) mw = null;
    const central = String(r.central || "").trim().slice(0, 90);
    if (!central) return null;
    return {
      central,
      unidad: central,
      mw_limite: mw,
      hora: String(r.hora || "").trim().slice(0, 8),
      motivo: String(r.motivo || "").trim().slice(0, 400),
      cont,
      dec,
      env: true
    };
  }).filter(Boolean).slice(0, 80);
}

async function extractSection(apiKey, text, fecha, seccion) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: buildPrompt(text, fecha, seccion) }]
    })
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("Anthropic error", r.status, detail.slice(0, 300));
    const err = new Error("upstream_" + r.status);
    err.http = r.status;
    throw err;
  }
  const data = await r.json();
  const out = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return safeParse(out);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "sen-extrae", model: MODEL });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "server_misconfigured" });
  if (!originOk(req)) return res.status(403).json({ error: "forbidden_origin" });

  const body = await readJson(req);
  const text = (body.text != null) ? String(body.text) : "";
  if (!text.trim()) return res.status(400).json({ error: "no_text" });

  try {
    const rows = await extractSection(apiKey, text, body.fecha || "", body.seccion || "");
    return res.status(200).json({ ok: true, rows, count: rows.length });
  } catch (e) {
    console.error("sen-extrae fatal", e);
    return res.status(502).json({ error: "upstream_error", http: e.http || null });
  }
}
