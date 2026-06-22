// api/control.js — Función serverless de Vercel (Node 18+, CommonJS)
// Proxy seguro a la API de Ubicquia: encender / apagar / dimerizar / ping / estado.
// Los secretos viven SOLO aquí, en variables de entorno de Vercel. Nunca en el front.
//
// Variables de entorno (Vercel → Project → Settings → Environment Variables):
//   UBI_CLIENT_ID        (secreto)  client_id de UbiHub
//   UBI_CLIENT_SECRET    (secreto)  client_secret de UbiHub
//   UBI_APP_CODE         (secreto)  "app code" → se envía como header (ver UBI_APP_CODE_HEADER)
//   UBI_APP_CODE_HEADER  opcional   nombre del header del app code   (def. "app-code"  ⚠ CONFIRMAR)
//   UBI_PANEL_ID         opcional    panel (agrupación de la plataforma; informativo)
//   UBI_SUBPANEL_ID      recomendado current-subpanel-id por defecto (p. ej. 1007)
//   UBI_ALLOWED_SUBPANELS recomendado subpaneles permitidos, coma-separados (def. = UBI_SUBPANEL_ID)
//   UBI_API_BASE         opcional   base de la API   (def. https://api.ubicquia.com/api)
//   UBI_AUTH_URL         opcional   endpoint OAuth   (def. realms/ubivu-prd)
//   UBI_CMD_VERSION      opcional   "v1" | "v2"      (def. v2)
//   UBI_NODE_LEVEL_TYPE_ID opcional (def. 1)
//   UBI_DIM_TYPE         opcional   string que pide setLightDim  (⚠ CONFIRMAR valor válido)
//   UBI_ALLOWED_IDS      recomendado  ids controlables, coma-separados  (def. "4")
//
// Acciones (POST JSON ó query):  state | on | off | dim(value) | ping

const AUTH_URL  = process.env.UBI_AUTH_URL  || 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const API_BASE  = (process.env.UBI_API_BASE || 'https://api.ubicquia.com/api').replace(/\/$/, '');
const CLIENT_ID = process.env.UBI_CLIENT_ID;
const CLIENT_SECRET = process.env.UBI_CLIENT_SECRET;
const APP_CODE  = process.env.UBI_APP_CODE || '';
const APP_CODE_HEADER = process.env.UBI_APP_CODE_HEADER || 'app-code'; // ⚠ confirmar nombre real del header
const PANEL_ID  = process.env.UBI_PANEL_ID || ''; // informativo (agrupación en la plataforma)
const SUBPANEL_DEFAULT = process.env.UBI_SUBPANEL_ID || '';
const ALLOWED_SUBPANELS = (process.env.UBI_ALLOWED_SUBPANELS || SUBPANEL_DEFAULT || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CMD_VER   = (process.env.UBI_CMD_VERSION || 'v2').toLowerCase();
const NODE_LEVEL_TYPE_ID = Number(process.env.UBI_NODE_LEVEL_TYPE_ID || 1);
const DIM_TYPE  = process.env.UBI_DIM_TYPE || '';
const ALLOWED_IDS = (process.env.UBI_ALLOWED_IDS || '4')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- Token OAuth cacheado en memoria del proceso (se reusa entre invocaciones "calientes") ---
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
  // margen de 30s para no usar un token a punto de expirar
  tokenCache = { value: j.access_token, exp: now + ((j.expires_in || 300) - 30) * 1000 };
  return tokenCache.value;
}

function authHeaders(token, subpanel) {
  const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (subpanel) h['current-subpanel-id'] = subpanel;
  if (APP_CODE) h[APP_CODE_HEADER] = APP_CODE;
  return h;
}

// Normaliza un nodo de /currentnodestate → { power:bool|null, dim:0-100|null }
// ⚠ Estos nombres de campo son la mejor lectura del esquema entregado.
//   Confirmar contra el payload REAL del nodo y ajustar si hace falta (un solo lugar).
function normalizeState(node) {
  // ON/OFF: preferimos light_status textual; si no, LState (0/1); si no, "state".
  let power = null;
  const ls = (node.light_status == null ? '' : String(node.light_status)).toLowerCase();
  if (ls === 'on' || ls === 'off') power = (ls === 'on');
  else if (node.LState != null) power = Number(node.LState) > 0;
  else if (node.state != null) power = String(node.state).toLowerCase().includes('on');

  // DIM: LD1State (0-100); respaldo LD2State / dualDim.
  let dim = null;
  for (const k of ['LD1State', 'LD2State', 'dualDim']) {
    if (node[k] != null && !isNaN(Number(node[k]))) { dim = Number(node[k]); break; }
  }
  return { power, dim, raw: node };
}

async function fetchState(id, subpanel) {
  const token = await getToken();
  const r = await fetch(API_BASE + '/currentnodestate?isActive=1', { headers: authHeaders(token, subpanel) });
  if (!r.ok) throw new Error('currentnodestate ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j.data) ? j.data : [];
  const node =
    list.find(n => String(n.id) === String(id)) ||
    list.find(n => String(n.node) === String(id)) ||
    list.find(n => String(n.dev_eui) === String(id));
  if (!node) return { found: false, power: null, dim: null };
  return { found: true, ...normalizeState(node) };
}

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
    headers: authHeaders(token, subpanel),
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.message) || (path + ' ' + r.status));
  return j;
}

const verb = (base) => (CMD_VER === 'v1' ? base : base + 'V2'); // setLightState ↔ setLightStateV2

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const p = Object.assign({}, req.query || {}, (req.body && typeof req.body === 'object') ? req.body : {});
    const action = String(p.action || 'state');
    const id = String(p.id || ALLOWED_IDS[0] || '');
    const subpanel = String(p.subpanel || SUBPANEL_DEFAULT || '');

    // Guarda: solo ids y subpaneles autorizados (no cualquier nodo/subpanel del cliente).
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
      await sendCommand('/nodes/' + verb('setLightState'), 1, id, subpanel);  // ⚠ confirmar: 1 = encendido
      return res.status(200).json({ ok: true });
    }
    if (action === 'off') {
      await sendCommand('/nodes/' + verb('setLightState'), 0, id, subpanel);  // ⚠ confirmar: 0 = apagado
      return res.status(200).json({ ok: true });
    }
    if (action === 'dim') {
      const value = Math.max(0, Math.min(100, Math.round(Number(p.value))));
      if (isNaN(value)) return res.status(400).json({ ok: false, error: 'value inválido' });
      await sendCommand('/nodes/' + verb('setLightDim'), value, id, subpanel, { dim_type: DIM_TYPE });
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
};
