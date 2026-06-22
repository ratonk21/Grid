// api/control.js — Función serverless de Vercel (Node 18+, sintaxis ES Module / export default)
// Proxy seguro a la API de Ubicquia: estado / encender / apagar / dimerizar / ping.
// Los secretos viven SOLO aquí (variables de entorno de Vercel). Nunca en el front.
//
// Se usa `export default` (ESM) porque el repo trata los .js como módulos
// (package.json con "type":"module"). Por eso NO se usa module.exports.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   UBI_CLIENT_ID        (secreto)    p. ej. 803956.ebustos_superuser@ubicquia.com
//   UBI_CLIENT_SECRET    (secreto)    client_secret de UbiHub
//   UBI_SUBPANEL_ID      recomendado  current-subpanel-id por defecto (1007)
//   UBI_ALLOWED_SUBPANELS recomendado subpaneles permitidos, coma-separados (def. = UBI_SUBPANEL_ID)
//   UBI_ALLOWED_IDS      recomendado  ids de nodo controlables, coma-separados (def. "4")
//   UBI_DIM_TYPE         opcional     dim_type para setLightDimV2 (def. "string", valor probado OK)
//   UBI_API_BASE         opcional     def. https://api.ubicquia.com/api
//   UBI_AUTH_URL         opcional     def. realms/ubivu-prd
//   UBI_NODE_LEVEL_TYPE_ID opcional   def. 1
//   UBI_APP_CODE / UBI_APP_CODE_HEADER  opcional  (los curls que funcionan NO lo usan; dejar vacío)

const AUTH_URL  = process.env.UBI_AUTH_URL  || 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const API_BASE  = (process.env.UBI_API_BASE || 'https://api.ubicquia.com/api').replace(/\/$/, '');
const CLIENT_ID = process.env.UBI_CLIENT_ID;
const CLIENT_SECRET = process.env.UBI_CLIENT_SECRET;
const SUBPANEL_DEFAULT = process.env.UBI_SUBPANEL_ID || '';
const ALLOWED_SUBPANELS = (process.env.UBI_ALLOWED_SUBPANELS || SUBPANEL_DEFAULT || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_IDS = (process.env.UBI_ALLOWED_IDS || '4')
  .split(',').map(s => s.trim()).filter(Boolean);
const NODE_LEVEL_TYPE_ID = Number(process.env.UBI_NODE_LEVEL_TYPE_ID || 1);
const DIM_TYPE  = process.env.UBI_DIM_TYPE || 'string'; // valor probado OK contra setLightDimV2
// UBI_APP_CODE se reutiliza como CÓDIGO DE ACCESO de la app (gate). Ya NO se manda a Ubicquia.
// .trim() evita el falso "incorrecto" si la variable de Vercel quedó con un salto de línea o espacio.
const ACCESS_CODE = (process.env.UBI_APP_CODE || '').trim();

// --- Token OAuth cacheado en memoria del proceso (se reusa entre invocaciones calientes) ---
let tokenCache = { value: null, exp: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.exp) return tokenCache.value;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Faltan UBI_CLIENT_ID / UBI_CLIENT_SECRET en Vercel');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'openid',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('Auth falló (' + r.status + ')');
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: now + ((j.expires_in || 300) - 30) * 1000 };
  return tokenCache.value;
}

// Headers idénticos a los curls que funcionan: accept + current-subpanel-id + Authorization (+ Content-Type en POST).
function headers(token, subpanel, withJson) {
  const h = { accept: 'application/json', Authorization: 'Bearer ' + token };
  if (subpanel) h['current-subpanel-id'] = subpanel;
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}

// Lee el estado real del nodo. /v3/nodes/{id}?type=light devuelve el nodo directo en data.
// Campos confirmados: light_status ("ON"/"OFF") = encendido; LD1State (0-100) = dimerizado.
async function fetchState(id, subpanel) {
  const token = await getToken();
  const url = API_BASE + '/v3/nodes/' + encodeURIComponent(id) + '?type=light';
  const r = await fetch(url, { headers: headers(token, subpanel, false) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.message) || ('v3/nodes ' + r.status));
  const n = j && j.data;
  if (!n || typeof n !== 'object') return { found: false, power: null, dim: null };

  const ls = (n.light_status == null ? '' : String(n.light_status)).toLowerCase();
  const power = (ls === 'on') ? true : (ls === 'off') ? false : null;
  const dim = (n.LD1State != null && !isNaN(Number(n.LD1State))) ? Number(n.LD1State) : null;

  // Campos crudos para graficar en el tiempo (todos los candidatos; el front decide cuáles mostrar).
  const num = v => (v != null && !isNaN(Number(v))) ? Number(v) : null;
  const m = {
    VState: num(n.VState), V1State: num(n.V1State),
    CState: num(n.CState), C1State: num(n.C1State),
    power: num(n.power),
    PFState: num(n.PFState), powerFactorState: num(n.powerFactorState),
    LD1State: num(n.LD1State),
    on: power === true ? 1 : (power === false ? 0 : null),
  };

  return { found: true, power, dim, nodeStatus: n.node_status || null, updatedAt: n.updatedDateTime || null, m };
}

// Envía un comando V2 (setLightStateV2 / setLightDimV2 / setMQTTPing).
async function sendCommand(path, value, id, subpanel, extraBody) {
  const token = await getToken();
  const body = {
    id_list: [{ id: Number(id) }],
    value,
    node_level_type_id: NODE_LEVEL_TYPE_ID,
    ...(extraBody || {}),
  };
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: headers(token, subpanel, true),
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.status === 'failed')) {
    throw new Error((j && j.message) || (path + ' ' + r.status));
  }
  return j;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const p = Object.assign({}, req.query || {}, (req.body && typeof req.body === 'object') ? req.body : {});
    const action = String(p.action || 'state');
    const id = String(p.id || ALLOWED_IDS[0] || '');
    const subpanel = String(p.subpanel || SUBPANEL_DEFAULT || '');
    const code = String(p.code || '').trim();

    // Puerta de acceso (verify): valida el código SIN tocar la API de Ubicquia.
    if (action === 'verify') {
      if (!ACCESS_CODE) return res.status(200).json({ ok: true, required: false });
      if (code === ACCESS_CODE) return res.status(200).json({ ok: true, required: true });
      return res.status(401).json({ ok: false, error: 'código de acceso inválido' });
    }
    // Para cualquier otra acción, exigir el código si está configurado.
    if (ACCESS_CODE && code !== ACCESS_CODE) {
      return res.status(401).json({ ok: false, error: 'código de acceso inválido' });
    }

    // Guardas: solo ids y subpaneles autorizados.
    if (!ALLOWED_IDS.includes(id)) {
      return res.status(403).json({ ok: false, error: 'id no autorizado' });
    }
    if (ALLOWED_SUBPANELS.length && subpanel && !ALLOWED_SUBPANELS.includes(subpanel)) {
      return res.status(403).json({ ok: false, error: 'subpanel no autorizado' });
    }

    if (action === 'state') {
      const s = await fetchState(id, subpanel);
      return res.status(200).json({ ok: true, ...s });
    }
    if (action === 'on') {
      await sendCommand('/nodes/setLightStateV2', 1, id, subpanel);
      return res.status(200).json({ ok: true });
    }
    if (action === 'off') {
      await sendCommand('/nodes/setLightStateV2', 0, id, subpanel);
      return res.status(200).json({ ok: true });
    }
    if (action === 'dim') {
      const value = Math.max(0, Math.min(100, Math.round(Number(p.value))));
      if (isNaN(value)) return res.status(400).json({ ok: false, error: 'value inválido' });
      await sendCommand('/nodes/setLightDimV2', value, id, subpanel, { dim_type: DIM_TYPE });
      return res.status(200).json({ ok: true, value });
    }
    if (action === 'ping') {
      await sendCommand('/nodes/setMQTTPing', 0, id, subpanel);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'acción desconocida: ' + action });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
}
