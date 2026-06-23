// api/control.js — Proxy serverless Ubicquia (ESM). Multi-panel + multi-nodo.
// Acciones: panels · verify · nodes · state · states · command · reboot
//
// ESCALABLE A VARIOS PANELES
// Cada panel (cliente) tiene SUS PROPIAS credenciales OAuth, por eso se nombran
// por id:  UBICQUIA_<panelId>_CLIENT_ID  /  UBICQUIA_<panelId>_CLIENT_SECRET
// (la misma convención que ya usa la función de descarga de datos).
// Un único registro JSON dice qué paneles existen y sus subpaneles (sin secretos):
//   UBI_PANELS = [
//     {"id":"1494","name":"Default · Tele gestión MED","subpanels":["437","930","912"]},
//     {"id":"803956","name":"Sales-Latam","subpanels":["1007"]}
//   ]
// Gate único:  APP_ACCESS_CODE  (validado en CADA acción).
//
// Para agregar un panel: 2 variables de credenciales + una entrada en UBI_PANELS.
//
// Variables de entorno (Vercel · Production):
//   APP_ACCESS_CODE                         código de acceso (gate)
//   UBI_PANELS                              registro JSON [{id,name,subpanels[]}]
//   UBICQUIA_<id>_CLIENT_ID / _SECRET       credenciales por panel
//   UBI_API_BASE   = https://api.ubicquia.com/api
//   UBI_AUTH_URL   = https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token
//   UBI_NODE_LEVEL_TYPE_ID = 1 · UBI_DIM_TYPE = string
//   UBI_REBOOT_MAX = 5         (tope duro de dispositivos por reinicio)
//   UBI_BATCH_SIZE = 250 · UBI_NODES_PER_PAGE = 250 · UBI_NODES_MAX_PAGES = 40
//   UBI_NODES_TTL_MS = 300000 · UBI_STATES_MAX = 80 · UBI_STATES_CONCURRENCY = 6
// Compatibilidad: si no hay UBI_PANELS, se arma un registro de 1 panel con
//   UBI_PANEL_ID + UBI_ALLOWED_SUBPANELS + UBI_CLIENT_ID/UBI_CLIENT_SECRET.

const API_BASE  = process.env.UBI_API_BASE  || 'https://api.ubicquia.com/api';
const AUTH_URL  = process.env.UBI_AUTH_URL  || 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const NLT_ID    = Number(process.env.UBI_NODE_LEVEL_TYPE_ID || 1);
const DIM_TYPE  = process.env.UBI_DIM_TYPE  || 'string';
const REBOOT_MAX= Number(process.env.UBI_REBOOT_MAX     || 5);
const BATCH     = Number(process.env.UBI_BATCH_SIZE     || 250);
const PER_PAGE  = Number(process.env.UBI_NODES_PER_PAGE || 250);
const MAX_PAGES = Number(process.env.UBI_NODES_MAX_PAGES|| 40);
const NODES_TTL = Number(process.env.UBI_NODES_TTL_MS   || 300000);
const STATES_MAX= Number(process.env.UBI_STATES_MAX     || 80);
const CONC      = Number(process.env.UBI_STATES_CONCURRENCY || 6);
const APP_ACCESS_CODE = (process.env.APP_ACCESS_CODE || process.env.UBI_APP_CODE || '').trim();

// ÁMBITOS (scopes) — cada código habilita un conjunto de acciones.
// ESCALABLE: define APP_CODE_<NOMBRE> y agrega su ámbito a SCOPE_ACTIONS.
//   APP_ACCESS_CODE → ámbito "control"  (encender/apagar/dim)
//   APP_CODE_REBOOT → ámbito "reboot"   (reiniciar unidades)
// Cada app (control/, reboot/) usa SU código y solo puede lo de su ámbito.
const SCOPE_ACTIONS = {
  control: ['panels','verify','nodes','state','states','command'],
  reboot:  ['panels','verify','nodes','state','reboot'],
};
function loadCodes(){
  const c = {};
  if (APP_ACCESS_CODE) c.control = APP_ACCESS_CODE;
  for (const k of Object.keys(process.env)){
    const mt = k.match(/^APP_CODE_(.+)$/);
    if (mt){ const v = (process.env[k] || '').trim(); if (v) c[mt[1].toLowerCase()] = v; }
  }
  const legacyReboot = (process.env.APP_REBOOT_CODE || '').trim(); // retro-compat
  if (legacyReboot && !c.reboot) c.reboot = legacyReboot;
  return c;
}
const CODES = loadCodes();
const scopeOf = code => { const t = String(code || '').trim(); return Object.keys(CODES).find(s => CODES[s] === t) || null; };
const scopeAllows = (scope, action) => !!(SCOPE_ACTIONS[scope] && SCOPE_ACTIONS[scope].includes(action));

// ---- Registro de paneles ----
function loadPanels(){
  const raw = process.env.UBI_PANELS;
  if (raw){
    try{
      const arr = JSON.parse(raw);
      return arr.map(p => ({
        id: String(p.id),
        name: p.name || ('Panel ' + p.id),
        subpanels: (p.subpanels || []).map(String)
      })).filter(p => p.id);
    }catch(_){ /* cae a compat abajo */ }
  }
  // Compatibilidad: un solo panel desde variables antiguas
  const legacyId = (process.env.UBI_PANEL_ID || '').trim();
  if (legacyId){
    const subs = (process.env.UBI_ALLOWED_SUBPANELS || process.env.UBI_SUBPANEL_ID || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return [{ id: legacyId, name: 'Panel ' + legacyId, subpanels: subs }];
  }
  return [];
}
const PANELS = loadPanels();
const findPanel = id => PANELS.find(p => p.id === String(id));
function panelCreds(id){
  // por-panel; con fallback a credenciales legacy si el id coincide con UBI_PANEL_ID
  let cid = process.env['UBICQUIA_' + id + '_CLIENT_ID'];
  let sec = process.env['UBICQUIA_' + id + '_CLIENT_SECRET'];
  if ((!cid || !sec) && (process.env.UBI_PANEL_ID || '').trim() === String(id)){
    cid = cid || process.env.UBI_CLIENT_ID;
    sec = sec || process.env.UBI_CLIENT_SECRET;
  }
  return { cid, sec };
}

// ---- OAuth token (cache por panel) ----
const _tok = {}; // { [panelId]: { v, exp } }
async function getToken(panelId){
  const c = _tok[panelId];
  if (c && Date.now() < c.exp) return c.v;
  const { cid, sec } = panelCreds(panelId);
  if (!cid || !sec){ const e = new Error('Faltan credenciales del panel ' + panelId); e.http = 500; throw e; }
  const body = new URLSearchParams({ grant_type:'client_credentials', scope:'openid', client_id:cid, client_secret:sec });
  const r = await fetch(AUTH_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!r.ok){ const e = new Error('Auth falló ('+r.status+') panel '+panelId); e.http = 502; throw e; }
  const j = await r.json();
  _tok[panelId] = { v:j.access_token, exp: Date.now() + ((j.expires_in||300)-30)*1000 };
  return j.access_token;
}
function headers(token, subpanel, withJson){
  const h = { accept:'application/json', Authorization:'Bearer '+token };
  if (subpanel) h['current-subpanel-id'] = String(subpanel);
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}

// ---- Caché de nodos por panel:subpanel ----
const _nodes = {}; // { "panel:subpanel": { t, list } }
async function loadNodes(panelId, subpanel){
  const key = panelId + ':' + subpanel;
  const c = _nodes[key];
  if (c && (Date.now()-c.t) < NODES_TTL) return c.list;
  const token = await getToken(panelId);
  let page = 1, last = 1, out = [], capped = false;
  do {
    const url = `${API_BASE}/v3/nodes?query=1&page=${page}&per_page=${PER_PAGE}`;
    const r = await fetch(url, { headers: headers(token, subpanel) });
    if (!r.ok){ const e = new Error('No se pudo listar nodos ('+r.status+')'); e.http = 502; throw e; }
    const j = await r.json();
    (j.data || []).forEach(n => out.push({
      id:n.id, serial:n.serial_number, dev_eui:n.dev_eui, node:n.node, state:n.state, isActive:n.isActive
    }));
    last = (j.meta && j.meta.last_page) || 1;
    page++;
    if (page > MAX_PAGES && page <= last){ capped = true; break; }
  } while (page <= last);
  const list = { nodes: out, total: out.length, capped };
  _nodes[key] = { t: Date.now(), list };
  return list;
}
const idSet = list => new Set(list.nodes.map(n => Number(n.id)));

// ---- Lectura de estado (luz) ----
function mapState(n){
  if (!n) return { found:false };
  const onTxt = String(n.light_status ?? '').toUpperCase();
  const power = onTxt==='ON' ? true : onTxt==='OFF' ? false : null;
  const dim   = n.LD1State!=null ? Number(n.LD1State) : null;
  return {
    found:true, power, dim,
    nodeStatus: n.node_status || n.state || null,
    updatedAt:  n.updatedDateTime || n.updated_at || null,
    serial: n.serial_number, dev_eui: n.dev_eui,
    m:{ VState:n.VState, V1State:n.V1State, CState:n.CState, C1State:n.C1State,
        power:n.power, PFState:n.PFState, powerFactorState:n.powerFactorState,
        LD1State:n.LD1State, on: power===true?1:0 }
  };
}
async function readOne(token, subpanel, id){
  const r = await fetch(`${API_BASE}/v3/nodes/${id}?type=light`, { headers: headers(token, subpanel) });
  if (!r.ok) return { id, found:false, error:'HTTP '+r.status };
  const j = await r.json();
  const node = Array.isArray(j.data) ? j.data[0] : j.data;
  return Object.assign({ id }, mapState(node));
}
async function readMany(token, subpanel, ids){
  const out = []; let i = 0;
  async function worker(){ while (i < ids.length){ const k = i++; out[k] = await readOne(token, subpanel, ids[k]); } }
  await Promise.all(Array.from({length: Math.min(CONC, ids.length)}, worker));
  return out;
}

// ---- Comando en lote (on/off/dim) ----
async function sendCommand(token, subpanel, op, value, ids){
  const endpoint = op==='dim' ? 'setLightDimV2' : 'setLightStateV2';
  const val = op==='on' ? 1 : op==='off' ? 0 : Number(value);
  let sent = 0, batches = 0;
  for (let i=0; i<ids.length; i+=BATCH){
    const chunk = ids.slice(i, i+BATCH);
    const body = { id_list: chunk.map(id => ({ id: Number(id) })), value: val, node_level_type_id: NLT_ID };
    if (op==='dim') body.dim_type = DIM_TYPE;
    const r = await fetch(`${API_BASE}/nodes/${endpoint}`, { method:'POST', headers: headers(token, subpanel, true), body: JSON.stringify(body) });
    let j; try{ j = await r.json(); }catch(_){ j = {}; }
    if (!r.ok || j.status==='failed'){ const e = new Error(j.message || ('Comando falló ('+r.status+')')); e.http = 502; throw e; }
    sent += chunk.length; batches++;
  }
  return { sent, batches };
}

// ---- Reinicio (restartNode) — tope duro de REBOOT_MAX ----
async function rebootNodes(token, subpanel, ids){
  const body = { id_list: ids.map(id => ({ id: Number(id) })), value: 1, node_level_type_id: NLT_ID };
  const r = await fetch(`${API_BASE}/nodes/restartNode`, { method:'POST', headers: headers(token, subpanel, true), body: JSON.stringify(body) });
  let j; try{ j = await r.json(); }catch(_){ j = {}; }
  if (!r.ok || j.status==='failed'){ const e = new Error(j.message || ('Reinicio falló ('+r.status+')')); e.http = 502; throw e; }
  const accepted = j.status==='success' && (!j.data || j.data.response_status !== false);
  return { accepted, controlName: (j.data && j.data.controlName) || 'Reboot unit' };
}

// ===================== HANDLER =====================
export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Método no permitido' });
  let b = req.body;
  if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(_){ b = {}; } }
  b = b || {};
  const action = b.action;
  const scope  = scopeOf(b.code);   // 'control' | 'reboot' | null

  try {
    if (!scope) return res.status(401).json({ ok:false, error:'Código de acceso inválido' });

    // verify — valida y devuelve el ámbito
    if (action === 'verify') return res.status(200).json({ ok:true, scope });

    // cada código solo puede las acciones de su ámbito
    if (!scopeAllows(scope, action))
      return res.status(403).json({ ok:false, error:'Acción no permitida para este acceso («'+scope+'»)' });

    // panels — registro de paneles (sin secretos)
    if (action === 'panels'){
      return res.status(200).json({ ok:true, scope, panels: PANELS.map(p => ({ id:p.id, name:p.name, subpanels:p.subpanels })) });
    }

    // resolver + validar panel
    const panel = findPanel(b.panel) || (PANELS.length ? PANELS[0] : null);
    if (!panel) return res.status(500).json({ ok:false, error:'No hay paneles configurados (UBI_PANELS)' });

    // resolver + validar subpanel
    const subpanel = String(b.subpanel || (panel.subpanels[0] || '')).trim();
    if (panel.subpanels.length && subpanel && !panel.subpanels.includes(subpanel))
      return res.status(403).json({ ok:false, error:'Subpanel no permitido para el panel '+panel.id+': '+subpanel });

    if (action === 'nodes'){
      const list = await loadNodes(panel.id, subpanel);
      return res.status(200).json({ ok:true, nodes:list.nodes, total:list.total, capped:list.capped, panel:panel.id, subpanel });
    }

    const token = await getToken(panel.id);

    if (action === 'state'){
      const id = Number(b.id);
      if (!id) return res.status(400).json({ ok:false, error:'Falta id' });
      const list = await loadNodes(panel.id, subpanel);
      if (!idSet(list).has(id)) return res.status(403).json({ ok:false, error:'id fuera del subpanel' });
      const s = await readOne(token, subpanel, id);
      return res.status(200).json(Object.assign({ ok:true }, s));
    }

    if (action === 'states'){
      let ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok:false, error:'Falta ids[]' });
      const list = await loadNodes(panel.id, subpanel); const allow = idSet(list);
      ids = ids.filter(id => allow.has(id));
      let capped = false;
      if (ids.length > STATES_MAX){ ids = ids.slice(0, STATES_MAX); capped = true; }
      const states = await readMany(token, subpanel, ids);
      return res.status(200).json({ ok:true, states, capped, max:STATES_MAX });
    }

    if (action === 'command'){
      const op = b.op;
      if (!['on','off','dim'].includes(op)) return res.status(400).json({ ok:false, error:'op inválida' });
      let ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok:false, error:'Falta ids[]' });
      if (op==='dim'){ const v = Number(b.value); if (isNaN(v) || v<0 || v>100) return res.status(400).json({ ok:false, error:'value 0-100' }); }
      const list = await loadNodes(panel.id, subpanel); const allow = idSet(list);
      const bad = ids.filter(id => !allow.has(id));
      if (bad.length) return res.status(403).json({ ok:false, error:'ids fuera del subpanel: '+bad.join(',') });
      const out = await sendCommand(token, subpanel, op, b.value, ids);
      return res.status(200).json(Object.assign({ ok:true, op }, out));
    }

    if (action === 'reboot'){
      let ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok:false, error:'Falta ids[]' });
      // tope duro: máximo REBOOT_MAX dispositivos
      if (ids.length > REBOOT_MAX) return res.status(400).json({ ok:false, error:'Máximo '+REBOOT_MAX+' dispositivos por reinicio' });
      const list = await loadNodes(panel.id, subpanel); const allow = idSet(list);
      const bad = ids.filter(id => !allow.has(id));
      if (bad.length) return res.status(403).json({ ok:false, error:'ids fuera del subpanel: '+bad.join(',') });
      const out = await rebootNodes(token, subpanel, ids);
      return res.status(200).json({ ok: out.accepted, rebooted: ids, controlName: out.controlName, max: REBOOT_MAX });
    }

    return res.status(400).json({ ok:false, error:'Acción desconocida' });
  } catch (e){
    return res.status(e.http || 502).json({ ok:false, error: e.message || 'Error en la pasarela' });
  }
}
