/* ════════════════════════════════════════════════════════════════
   /api/ubicquia.js  —  Proxy seguro a Ubicquia
   El client_id y client_secret viven SOLO aquí (variables de entorno).
   El navegador nunca los ve: solo manda IMEI + fechas y recibe datos.
   action 'all' = 1 autenticación + los 5 datasets de 1 intervalo.
   Reintenta con espera cuando Ubicquia responde 429 (Too Many Requests).
   ════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

export const config = { maxDuration: 60 }; // segundos; sube/baja según tu plan

const AUTH_URL   = 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const METRIX_URL = 'https://api.ubicquia.com/api/ubigrid/transformer/metrix/list';
const NOTIF_URL  = 'https://api.ubicquia.com/api/v2/notification-nodes';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Comparación en tiempo constante (evita filtrar el código por timing)
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// fetch con reintentos ante 429 / 503 (backoff exponencial, respeta Retry-After).
// Presupuesto acotado para no exceder maxDuration (60s).
async function fetchRetry(url, opts) {
  const maxRetries = 5;
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, opts);
    if (r.status !== 429 && r.status !== 503) return r;
    if (attempt >= maxRetries) return r; // el caller maneja el !ok
    const ra = parseInt(r.headers.get('retry-after') || '', 10);
    const base = Number.isFinite(ra) ? ra * 1000 : delay;
    const jitter = Math.floor(Math.random() * 400);
    await sleep(Math.min(base + jitter, 10000));
    delay = Math.min(delay * 2, 10000);
  }
}

function resolveCreds(panel) {
  if (panel) {
    const key = String(panel).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const id = process.env[`UBICQUIA_${key}_CLIENT_ID`];
    const secret = process.env[`UBICQUIA_${key}_CLIENT_SECRET`];
    if (id && secret) return { id, secret };
    return null;
  }
  const id = process.env.UBICQUIA_CLIENT_ID;
  const secret = process.env.UBICQUIA_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  return null;
}

async function getToken(creds) {
  const r = await fetchRetry(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'openid',
      client_id: creds.id,
      client_secret: creds.secret,
    }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}`);
  return (await r.json()).access_token;
}

// Métricas de transformador (POST paginado)
async function fetchMetrix(token, { imei, start, end, subpanel_id }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'current-subpanel-id': subpanel_id || '0',
  };
  const all = [];
  let page = 1;
  while (true) {
    const r = await fetchRetry(METRIX_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        start_datetime: start,
        end_datetime: end,
        imei: imei.trim(),
        serialNumber: imei.trim(),
        type: 'voltage',
        page: String(page),
        per_page: '20000',
      }),
    });
    if (!r.ok) throw new Error(`metrix ${r.status}`);
    const data = (await r.json()).data || [];
    if (data.length === 0) break;
    all.push(...data);
    page++;
  }
  return all;
}

// Notificaciones (GET paginado) filtradas por dev_eui == imei
async function fetchNotifications(token, { notification_type, start, end, subpanel_id, imei }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'current-subpanel-id': subpanel_id || '0',
  };
  const all = [];
  let page = 1;
  while (true) {
    const url = `${NOTIF_URL}?type=transformers`
      + `&start_date=${encodeURIComponent(start)}`
      + `&end_date=${encodeURIComponent(end)}`
      + `&notification_type=${encodeURIComponent(notification_type)}`
      + `&page=${page}&per_page=20000`;
    const r = await fetchRetry(url, { headers });
    if (!r.ok) throw new Error(`notif ${r.status}`);
    const nodes = (((await r.json()).data) || {}).nodes || [];
    if (nodes.length === 0) break;
    all.push(...nodes);
    page++;
  }
  return all.filter((n) => n.dev_eui === imei);
}

const NOTIF_TYPE = {
  sag:           'AlertAggregatedVoltageSag',
  swell:         'AlertAggregatedVoltageSwell120/240/277V',
  powerloss:     'AlertPowerLoss',
  powerrestored: 'AlertPowerRestored',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Candado OBLIGATORIO
  if (!process.env.APP_ACCESS_CODE) {
    return res.status(500).json({ error: 'missing_access_code_config' });
  }
  const code = req.headers['x-access-code'] || (req.body && req.body.accessCode) || '';
  if (!safeEqual(code, process.env.APP_ACCESS_CODE)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { action, imei, start, end, subpanel_id, panel } = req.body || {};
    if (!action || !imei || !start || !end) return res.status(400).json({ error: 'missing_params' });

    const creds = resolveCreds(panel);
    if (!creds) return res.status(500).json({ error: panel ? 'missing_credentials_for_panel' : 'missing_credentials', panel: panel || null });

    const token = await getToken(creds);
    const nb = { start, end, subpanel_id, imei };

    // 'all' = los 5 datasets del intervalo con UNA sola autenticación
    if (action === 'all') {
      const out = {
        metrix:        await fetchMetrix(token, { imei, start, end, subpanel_id }),
        sag:           await fetchNotifications(token, { notification_type: NOTIF_TYPE.sag, ...nb }),
        swell:         await fetchNotifications(token, { notification_type: NOTIF_TYPE.swell, ...nb }),
        powerloss:     await fetchNotifications(token, { notification_type: NOTIF_TYPE.powerloss, ...nb }),
        powerrestored: await fetchNotifications(token, { notification_type: NOTIF_TYPE.powerrestored, ...nb }),
      };
      return res.status(200).json({ data: out });
    }

    // Compatibilidad: datasets individuales
    let data;
    if (action === 'metrix') {
      data = await fetchMetrix(token, { imei, start, end, subpanel_id });
    } else if (NOTIF_TYPE[action]) {
      data = await fetchNotifications(token, { notification_type: NOTIF_TYPE[action], ...nb });
    } else {
      return res.status(400).json({ error: 'unknown_action' });
    }

    return res.status(200).json({ data });
  } catch (e) {
    return res.status(502).json({ error: 'upstream_error', detail: String(e.message || e) });
  }
}
