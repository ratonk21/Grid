// Vercel /api/ubicquia.js
// Descarga completa estilo script Python: metrix paginado + notificaciones paginadas.
// Requiere variables de entorno por panel:
// UBICQUIA_<PANEL>_CLIENT_ID
// UBICQUIA_<PANEL>_CLIENT_SECRET
// Opcional: UBICQUIA_ACCESS_CODE o ACCESS_CODE o DOWNLOAD_CODE

const TOKEN_URL = 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const DTM_METRIX_URL = 'https://api.ubicquia.com/api/ubigrid/transformer/metrix/list';
const NOTIFICATIONS_URL = 'https://api.ubicquia.com/api/v2/notification-nodes';
const PER_PAGE = 20000;
const MAX_PAGES = 100;

function pageSignature(rows) {
  const first = rows[0] || {};
  const last = rows[rows.length - 1] || {};
  return [
    rows.length,
    first.id || first.createdAt || first.date || first.dev_eui || '',
    last.id || last.createdAt || last.date || last.dev_eui || ''
  ].join('|');
}

function getEnv(name) {
  return process.env[name];
}

function normalizePanel(panel) {
  return String(panel || '646703').trim();
}

function getCredentials(panel) {
  const key = normalizePanel(panel);
  const clientId = getEnv(`UBICQUIA_${key}_CLIENT_ID`);
  const clientSecret = getEnv(`UBICQUIA_${key}_CLIENT_SECRET`);
  return { key, clientId, clientSecret };
}

function requireAccessCode(req, res) {
  const expected = getEnv('UBICQUIA_ACCESS_CODE') || getEnv('ACCESS_CODE') || getEnv('DOWNLOAD_CODE');
  if (!expected) return true;
  const got = req.headers['x-access-code'];
  if (got !== expected) {
    res.status(401).json({ error: 'Invalid access code' });
    return false;
  }
  return true;
}

async function getAccessToken(clientId, clientSecret) {
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('scope', 'openid');
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Auth HTTP ${response.status}: ${text}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error('Auth response did not include access_token');
  return json.access_token;
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getJson(url, headers) {
  const response = await fetch(url, { method: 'GET', headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function fetchMetrixAllPages({ token, subpanelId, imei, start, end }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'current-subpanel-id': String(subpanelId || '0'),
  };

  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = {
      start_datetime: start,
      end_datetime: end,
      imei: String(imei).trim(),
      serialNumber: String(imei).trim(),
      type: 'voltage',
      page: String(page),
      per_page: String(PER_PAGE),
    };

    const json = await postJson(DTM_METRIX_URL, headers, payload);
    const rows = Array.isArray(json.data) ? json.data : [];
    if (!rows.length) break;
    const sig = pageSignature(rows);
    if (seen.has(sig)) break;
    seen.add(sig);
    all.push(...rows);
    // Importante: NO detener por rows.length < PER_PAGE.
    // El script Python de referencia sigue pidiendo páginas hasta recibir una página vacía.
  }
  return all;
}

async function fetchNotificationsAllPages({ token, subpanelId, imei, start, end, notificationType }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'current-subpanel-id': String(subpanelId || '0'),
  };

  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${NOTIFICATIONS_URL}?type=transformers` +
      `&start_date=${encodeURIComponent(start)}` +
      `&end_date=${encodeURIComponent(end)}` +
      `&notification_type=${encodeURIComponent(notificationType)}` +
      `&page=${page}&per_page=${PER_PAGE}`;

    const json = await getJson(url, headers);
    const nodes = json && json.data && Array.isArray(json.data.nodes) ? json.data.nodes : [];
    if (!nodes.length) break;
    const sig = pageSignature(nodes);
    if (seen.has(sig)) break;
    seen.add(sig);
    all.push(...nodes.filter(n => String(n.dev_eui || '') === String(imei)));
    // Igual que el Python: seguir hasta página vacía, no detener por tamaño menor a PER_PAGE.
  }
  return all;
}

function safelyParseJson(x) {
  if (x == null) return {};
  if (typeof x === 'object') return x;
  try { return JSON.parse(x); }
  catch (_) {
    try { return JSON.parse(String(x).split("''").join('"').split('“').join('"').split('”').join('"')); }
    catch (__) { return {}; }
  }
}

function addMsgFields(rows) {
  return (rows || []).map(r => {
    const d = safelyParseJson(r.jsonData);
    return { ...r, MsgStr: d.msgStr, MsgType: d.msgType };
  });
}

function filterPowerLoss(rows) {
  return addMsgFields(rows).filter(r => ['AlertPowerLoss', 'AlertPowerLoss2'].includes(r.MsgStr) || r.alertvalue === 'Loss');
}

function filterPowerRestored(rows) {
  return addMsgFields(rows).filter(r => r.MsgStr === 'AlertPowerRestored' || r.alertvalue === 'Restored');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    if (!requireAccessCode(req, res)) return;

    const body = req.body || {};
    const action = body.action || 'all';
    const imei = String(body.imei || '').trim();
    const start = body.start;
    const end = body.end;
    const subpanelId = body.subpanel_id || '0';
    const { key, clientId, clientSecret } = getCredentials(body.panel);

    if (!imei || !start || !end) {
      res.status(400).json({ error: 'Missing imei, start or end' });
      return;
    }
    if (!clientId || !clientSecret) {
      res.status(500).json({ error: `Missing credentials for panel ${key}` });
      return;
    }

    const token = await getAccessToken(clientId, clientSecret);

    if (action !== 'all') {
      res.status(400).json({ error: 'Only action=all is supported by this endpoint' });
      return;
    }

    const [metrix, sag, swell, lossRaw, restoredRaw] = await Promise.all([
      fetchMetrixAllPages({ token, subpanelId, imei, start, end }),
      fetchNotificationsAllPages({ token, subpanelId, imei, start, end, notificationType: 'AlertAggregatedVoltageSag' }),
      fetchNotificationsAllPages({ token, subpanelId, imei, start, end, notificationType: 'AlertAggregatedVoltageSwell120/240/277V' }),
      fetchNotificationsAllPages({ token, subpanelId, imei, start, end, notificationType: 'AlertPowerLoss' }),
      fetchNotificationsAllPages({ token, subpanelId, imei, start, end, notificationType: 'AlertPowerRestored' }),
    ]);

    const powerloss = filterPowerLoss(lossRaw);
    const powerrestored = filterPowerRestored(restoredRaw);

    res.status(200).json({
      data: {
        metrix,
        sag,
        swell,
        powerloss,
        powerrestored,
        counts: {
          metrix: metrix.length,
          sag: sag.length,
          swell: swell.length,
          powerloss: powerloss.length,
          powerrestored: powerrestored.length,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
}
