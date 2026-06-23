// api/scan-bill.js  —  Vercel Serverless Function
// Proxy seguro: recibe la imagen del front, llama a la API de Anthropic con la
// clave guardada en el servidor y valida el código de acceso. La clave NUNCA
// viaja al navegador.
//
// Variables de entorno requeridas en Vercel:
//   ANTHROPIC_API_KEY   -> tu clave de la API de Anthropic (sk-ant-...)
//   BILL_ACCESS_CODE    -> el código de acceso de la carpeta bill

const MODEL = 'claude-sonnet-4-6';

const PROMPT = `Eres un extractor de datos de facturas y boletas de Latinoamérica.
Analiza la imagen del documento y devuelve SOLO un objeto JSON válido, sin texto adicional ni markdown.
Usa exactamente estos campos (si un dato no aparece usa null, NO inventes valores):
{
 "tipo_documento": "factura | boleta | recibo | nota de credito | otro",
 "descripcion": "resumen corto del gasto (ej: combustible, materiales, hospedaje)",
 "pais": "país emisor (Chile, Colombia, Perú, Argentina, México, Ecuador, Bolivia, Brasil, Uruguay, Paraguay, Panamá, Estados Unidos u Otro)",
 "moneda": "código de moneda local (CLP, COP, PEN, ARS, MXN, USD, BOB, BRL...)",
 "emisor": {"nombre": "", "rut": ""},
 "folio": "",
 "fecha_emision": "AAAA-MM-DD",
 "neto": 0,
 "iva": 0,
 "total": 0,
 "items": [{"descripcion":"", "cantidad":0, "total":0}],
 "texto_completo": "transcripción legible de todo el documento"
}
Pistas de país por identificador: RUT=Chile, NIT=Colombia, RUC=Perú o Ecuador, CUIT=Argentina, RFC=México.
Los montos como números sin separador de miles ni símbolo. Responde únicamente el JSON.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Body puede venir ya parseado (Vercel) o como string
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const ACCESS = process.env.BILL_ACCESS_CODE;
  const { code, image, media_type, check } = body;

  // 1) Validación de código (gate real del lado servidor)
  if (ACCESS) {
    if (code !== ACCESS) { res.status(401).json({ error: 'Código inválido' }); return; }
  }
  // Ping de validación del lock (no escanea)
  if (check) { res.status(200).json({ ok: true }); return; }

  // 2) Escaneo
  if (!image) { res.status(400).json({ error: 'Falta la imagen' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en el servidor' }); return; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: 'Error de la API', detail: data && data.error });
      return;
    }
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    res.status(200).json({ raw });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
