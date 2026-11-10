// api/control-pereira.js — UT Ilumina Pereira · backend aislado (panel 779337)
// Vercel serverless (ESM: el repo debe tener "type":"module" o el archivo ser .mjs).
// Acciones: panels | nodes | states | reboot.  Secretos SOLO aquí, nunca en el front.
// Para clonar a otro panel: cambiar PANEL_ID y crear sus 3 variables homónimas.

import { createHash, timingSafeEqual } from 'node:crypto';

const PANEL_ID = '779337';
const TENANT   = 'ut-ilumina-pereira';
const API      = 'https://api.ubicquia.com/api';
const AUTH     = 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';

// Convención de variables: UBICQUIA_<panelId>_* + APP_ACCESS_CODE_<panelId>
const env = (suf, def = '') => String(process.env[`UBICQUIA_${PANEL_ID}_${suf}`] ?? def).trim();
const PANEL_NAME  = env('NAME', 'UT Ilumina Pereira');
const CLIENT_ID   = env('CLIENT_ID');
const CLIENT_SEC  = env('CLIENT_SECRET');
// Código propio de esta app; si no existe, cae al código global ya desplegado.
const ACCESS_CODE = String(process.env[`APP_ACCESS_CODE_${PANEL_ID}`] ?? process.env.APP_ACCESS_CODE ?? '').trim();

const MAX_REBOOT = 5;                                   // tope duro (el front dice 5; el server manda)
const BIG_LIMIT  = Number(env('BIG_LIMIT',  300));      // sobre esto no se piden estados en vivo
const STATE_CAP  = Number(env('STATE_CAP',   60));      // lecturas de estado por llamada
const PAGE_CAP   = Number(env('PAGE_CAP',    80));      // 80 x 250 = 20.000 nodos
const CONC       = 6;
const NODES_TTL  = 5 * 60 * 1000;
const PER_PAGE   = 250;

// ── estado en memoria de la instancia ───────────────────────────────
let tok = { v: null, exp: 0 };
let cache = { at: 0, nodes: null, partial: false };
const fails = new Map();                                // ip -> {n, until}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b) => {
  const h = s => createHash('sha256').update(String(s), 'utf8').digest();
  try { return timingSafeEqual(h(a), h(b)); } catch { return false; }
};
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'local';

function throttled(ip) {
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= 10) return true;
  if (f && f.until <= Date.now()) fails.delete(ip);
  return false;
}
function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + 10 * 60 * 1000;
  fails.set(ip, f);
}

async function jfetch(url, opt = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opt);
      if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await sleep(600 * (i + 1)); continue; }
      const txt = await r.text();
      let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { /* respuesta no-JSON */ }
      return { status: r.status, ok: r.ok, json: j, raw: txt };
    } catch (e) { last = e; await sleep(500 * (i + 1)); }
  }
  throw last || new Error('upstream sin respuesta');
}

async function token() {
  if (tok.v && Date.now() < tok.exp - 30000) return tok.v;
  if (!CLIENT_ID || !CLIENT_SEC) throw new Error(`Faltan UBICQUIA_${PANEL_ID}_CLIENT_ID / _CLIENT_SECRET en el entorno`);
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'openid', client_id: CLIENT_ID, client_secret: CLIENT_SEC });
  const r = await jfetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok || !r.json || !r.json.access_token) throw new Error('Auth Ubicquia falló (HTTP ' + r.status + ')');
  tok = { v: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in || 300) * 1000) };
  return tok.v;
}

async function H(subpanel) {
  const h = { Authorization: 'Bearer ' + (await token()), accept: 'application/json' };
  if (subpanel && subpanel !== 'all') h['current-subpanel-id'] = String(subpanel);
  return h;
}

// Barrido único del panel (sin header de subpanel = todo). Cacheado; de aquí salen
// subpaneles, listado por subpanel y la allowlist de ids para reiniciar.
async function loadAll() {
  if (cache.nodes && Date.now() - cache.at < NODES_TTL) return cache;
  const headers = await H(null);
  const page = async n => {
    const r = await jfetch(`${API}/v3/nodes?page=${n}&per_page=${PER_PAGE}&sort_by=id&sort_dir=asc`, { headers });
    if (!r.ok) throw new Error('v3/nodes HTTP ' + r.status);
    return r.json || {};
  };
  const first = await page(1);
  const rows = Array.isArray(first.data) ? first.data.slice() : [];
  const last = Math.min(Number(first?.meta?.last_page || 1), PAGE_CAP);
  const pend = [];
  for (let p = 2; p <= last; p++) pend.push(p);
  while (pend.length) {
    const batch = pend.splice(0, CONC);
    const out = await Promise.all(batch.map(p => page(p).catch(() => null)));
    out.forEach(o => { if (o && Array.isArray(o.data)) rows.push(...o.data); });
  }
  cache = { at: Date.now(), nodes: rows, partial: Number(first?.meta?.last_page || 1) > PAGE_CAP };
  return cache;
}

const normNode = n => ({ id: Number(n.id), serial: n.serial_number || null, dev_eui: n.dev_eui || null });
const inSub = (n, sp) => sp === 'all' || String(n.subpanel_id ?? '') === String(sp);

function mapState(id, d) {
  if (!d) return { id, found: false };
  return {
    id,
    nodeStatus: d.node_status || d.nodeStatus || null,
    power: d.light_status == null ? null : String(d.light_status).toUpperCase() === 'ON',
    dim: d.LD1State != null ? Number(d.LD1State) : null,
    updatedAt: d.updatedDateTime || d.updated_at || null
  };
}

async function readStates(ids, subpanel) {
  const headers = await H(subpanel);
  const todo = ids.slice(0, STATE_CAP), out = [];
  while (todo.length) {
    const batch = todo.splice(0, CONC);
    const res = await Promise.all(batch.map(async id => {
      try {
        const r = await jfetch(`${API}/v3/nodes/${id}?type=light`, { headers });
        if (!r.ok) return { id, error: true };
        const d = r.json && (r.json.data || r.json);
        return mapState(id, Array.isArray(d) ? d[0] : d);
      } catch { return { id, error: true }; }
    }));
    out.push(...res);
  }
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return send(405, { ok: false, error: 'Método no permitido' });

  const ip = ipOf(req);
  if (throttled(ip)) return send(429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });

  let b;
  try { b = await readBody(req); } catch { return send(400, { ok: false, error: 'Cuerpo inválido' }); }
  const action   = String(b.action || '').trim();
  const code     = String(b.code || '').trim();
  const panel    = String(b.panel || '').trim();
  const subpanel = String(b.subpanel || '').trim() || 'all';

  if (b.tenant && String(b.tenant).trim() !== TENANT) return send(403, { ok: false, error: 'Instancia no corresponde' });
  if (!ACCESS_CODE) return send(500, { ok: false, error: `APP_ACCESS_CODE_${PANEL_ID} sin configurar en el entorno` });
  if (!code || !eq(code, ACCESS_CODE)) { noteFail(ip); return send(401, { ok: false, error: 'Código incorrecto' }); }
  fails.delete(ip);
  if (action !== 'panels' && panel && panel !== PANEL_ID) return send(403, { ok: false, error: 'Panel fuera de esta instancia' });

  try {
    if (action === 'panels') {
      const { nodes, partial } = await loadAll();
      const seen = new Map();
      nodes.forEach(n => { if (n.subpanel_id != null) seen.set(String(n.subpanel_id), String(n.subpanel_name || n.subpanel_id)); });
      const subpanels = seen.size
        ? [...seen].sort((a, c) => a[0].localeCompare(c[0], 'es', { numeric: true })).map(([id, name]) => ({ id, name }))
        : [{ id: 'all', name: 'Todo el panel (sin subpanel)' }];
      return send(200, { ok: true, panels: [{ id: PANEL_ID, name: PANEL_NAME, subpanels }], partial });
    }

    if (action === 'nodes') {
      const { nodes, partial } = await loadAll();
      const list = nodes.filter(n => inSub(n, subpanel)).map(normNode);
      return send(200, { ok: true, nodes: list, big: list.length > BIG_LIMIT, partial });
    }

    if (action === 'states') {
      const want = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isFinite);
      if (!want.length) return send(200, { ok: true, states: [] });
      const { nodes } = await loadAll();
      const allow = new Set(nodes.filter(n => inSub(n, subpanel)).map(n => Number(n.id)));
      const ids = want.filter(i => allow.has(i));
      const states = await readStates(ids, subpanel);
      return send(200, { ok: true, states, capped: ids.length > STATE_CAP, max: STATE_CAP });
    }

    if (action === 'reboot') {
      const want = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isFinite))];
      if (!want.length) return send(400, { ok: false, error: 'Sin unidades' });
      if (want.length > MAX_REBOOT) return send(400, { ok: false, error: `Máximo ${MAX_REBOOT} dispositivos por reinicio` });
      const { nodes } = await loadAll();
      const allow = new Set(nodes.filter(n => inSub(n, subpanel)).map(n => Number(n.id)));
      const bad = want.filter(i => !allow.has(i));
      if (bad.length) return send(403, { ok: false, error: 'Fuera del subpanel: ' + bad.join(', ') });

      const r = await jfetch(`${API}/nodes/restartNode`, {
        method: 'POST',
        headers: { ...(await H(subpanel)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_list: want.map(id => ({ id })), value: 1, node_level_type_id: 1 })
      });
      const j = r.json || {};
      const failed = String(j.status || '').toLowerCase() === 'failed';
      if (!r.ok || failed) return send(502, { ok: false, error: j.message || 'Reinicio rechazado (HTTP ' + r.status + ')' });
      // El nodo se cae y vuelve a registrarse: response_status true = ACEPTADO, no confirmado.
      return send(200, { ok: true, accepted: want.length, control: j?.data?.controlName || 'Reboot unit' });
    }

    return send(400, { ok: false, error: 'Acción desconocida' });
  } catch (e) {
    return send(502, { ok: false, error: String(e && e.message || e) });
  }
}
