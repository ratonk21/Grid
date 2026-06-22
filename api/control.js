// api/control.js — Proxy serverless Ubicquia (ESM). Multi-nodo.
// Acciones: verify · nodes · state · states · command
//
// Seguridad: código de acceso (server-side) en CADA acción + allowlist por
// SUBPANEL. Dentro de un subpanel permitido, cualquier id real del subpanel es
// válido (resuelto vía /v3/nodes). No se enumeran ids en variables de entorno.
//
// Variables de entorno (Vercel · Production):
//   UBI_CLIENT_ID, UBI_CLIENT_SECRET   (secretos OAuth)
//   UBI_APP_CODE                       (código de acceso; gate en cada acción)
//   UBI_SUBPANEL_ID                    (subpanel por defecto, ej. 1007)
//   UBI_ALLOWED_SUBPANELS              (csv de subpaneles permitidos, ej. "1007")
//   UBI_API_BASE        = https://api.ubicquia.com/api
//   UBI_AUTH_URL        = https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token
//   UBI_NODE_LEVEL_TYPE_ID = 1
//   UBI_DIM_TYPE        = string
//   UBI_BATCH_SIZE      = 250   (troceo de id_list por comando)
//   UBI_NODES_PER_PAGE  = 250
//   UBI_NODES_MAX_PAGES = 40    (tope de páginas al cargar el subpanel)
//   UBI_NODES_TTL_MS    = 300000 (caché de la lista de nodos)
//   UBI_STATES_MAX      = 80    (tope de nodos por lectura de estado)
//   UBI_STATES_CONCURRENCY = 6

const API_BASE  = process.env.UBI_API_BASE  || 'https://api.ubicquia.com/api';
const AUTH_URL  = process.env.UBI_AUTH_URL  || 'https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token';
const NLT_ID    = Number(process.env.UBI_NODE_LEVEL_TYPE_ID || 1);
const DIM_TYPE  = process.env.UBI_DIM_TYPE  || 'string';
const BATCH     = Number(process.env.UBI_BATCH_SIZE      || 250);
const PER_PAGE  = Number(process.env.UBI_NODES_PER_PAGE  || 250);
const MAX_PAGES = Number(process.env.UBI_NODES_MAX_PAGES || 40);
const NODES_TTL = Number(process.env.UBI_NODES_TTL_MS    || 300000);
const STATES_MAX= Number(process.env.UBI_STATES_MAX      || 80);
const CONC      = Number(process.env.UBI_STATES_CONCURRENCY || 6);
const ACCESS    = (process.env.UBI_APP_CODE || '').trim();
const DEF_SUB   = (process.env.UBI_SUBPANEL_ID || '1007').trim();
const ALLOWED_SUBS = (process.env.UBI_ALLOWED_SUBPANELS || DEF_SUB)
  .split(',').map(s => s.trim()).filter(Boolean);

// ---- OAuth token (cache) ----
let _tok = { v:null, exp:0 };
async function getToken(){
  if (_tok.v && Date.now() < _tok.exp) return _tok.v;
  const body = new URLSearchParams({
    grant_type:'client_credentials', scope:'openid',
    client_id: process.env.UBI_CLIENT_ID, client_secret: process.env.UBI_CLIENT_SECRET
  });
  const r = await fetch(AUTH_URL, { method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  if (!r.ok) throw new Error('Auth falló ('+r.status+')');
  const j = await r.json();
  _tok = { v:j.access_token, exp: Date.now() + ((j.expires_in||300)-30)*1000 };
  return _tok.v;
}
function headers(token, subpanel, withJson){
  const h = { accept:'application/json', Authorization:'Bearer '+token, 'current-subpanel-id': String(subpanel) };
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}

// ---- Caché de nodos por subpanel (serial/id/dev_eui → nodo) ----
const _nodes = {}; // { [subpanel]: { t, list } }
async function loadNodes(subpanel){
  const c = _nodes[subpanel];
  if (c && (Date.now()-c.t) < NODES_TTL) return c.list;
  const token = await getToken();
  let page = 1, last = 1, out = [], capped = false;
  do {
    const url = `${API_BASE}/v3/nodes?query=1&page=${page}&per_page=${PER_PAGE}`;
    const r = await fetch(url, { headers: headers(token, subpanel) });
    if (!r.ok) throw new Error('No se pudo listar nodos ('+r.status+')');
    const j = await r.json();
    (j.data || []).forEach(n => out.push({
      id:n.id, serial:n.serial_number, dev_eui:n.dev_eui, node:n.node,
      state:n.state, isActive:n.isActive
    }));
    last = (j.meta && j.meta.last_page) || 1;
    page++;
    if (page > MAX_PAGES && page <= last){ capped = true; break; }
  } while (page <= last);
  const list = { nodes: out, total: out.length, capped };
  _nodes[subpanel] = { t: Date.now(), list };
  return list;
}
function idSet(list){ return new Set(list.nodes.map(n => Number(n.id))); }

// ---- Lectura de estado de un nodo (luz) ----
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

// ---- Comando en lote ----
async function sendCommand(token, subpanel, op, value, ids){
  const endpoint = op==='dim' ? 'setLightDimV2' : 'setLightStateV2';
  const val = op==='on' ? 1 : op==='off' ? 0 : Number(value);
  const batches = [];
  for (let i=0; i<ids.length; i+=BATCH) batches.push(ids.slice(i, i+BATCH));
  let sent = 0;
  for (const chunk of batches){
    const body = { id_list: chunk.map(id => ({ id: Number(id) })), value: val, node_level_type_id: NLT_ID };
    if (op==='dim') body.dim_type = DIM_TYPE;
    const r = await fetch(`${API_BASE}/nodes/${endpoint}`, {
      method:'POST', headers: headers(token, subpanel, true), body: JSON.stringify(body) });
    let j; try{ j = await r.json(); }catch(_){ j = {}; }
    if (!r.ok || j.status==='failed') throw new Error(j.message || ('Comando falló ('+r.status+')'));
    sent += chunk.length;
  }
  return { sent, batches: batches.length };
}

// ===================== HANDLER =====================
export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Método no permitido' });
  let b = req.body;
  if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(_){ b = {}; } }
  b = b || {};
  const action = b.action;

  // Gate: el código se valida en CADA acción
  const codeReq = ACCESS.length > 0;
  const codeOk  = !codeReq || (String(b.code || '').trim() === ACCESS);

  try {
    if (action === 'verify'){
      if (!codeOk) return res.status(401).json({ ok:false, error:'Código incorrecto' });
      return res.status(200).json({ ok:true, required: codeReq });
    }
    if (!codeOk) return res.status(401).json({ ok:false, error:'Código de acceso inválido' });

    const subpanel = String(b.subpanel || DEF_SUB).trim();
    if (!ALLOWED_SUBS.includes(subpanel))
      return res.status(403).json({ ok:false, error:'Subpanel no permitido: '+subpanel });

    if (action === 'nodes'){
      const list = await loadNodes(subpanel);
      return res.status(200).json({ ok:true, nodes:list.nodes, total:list.total, capped:list.capped, subpanel });
    }

    const token = await getToken();

    if (action === 'state'){
      const id = Number(b.id);
      if (!id) return res.status(400).json({ ok:false, error:'Falta id' });
      const list = await loadNodes(subpanel);
      if (!idSet(list).has(id)) return res.status(403).json({ ok:false, error:'id fuera del subpanel' });
      const s = await readOne(token, subpanel, id);
      return res.status(200).json(Object.assign({ ok:true }, s));
    }

    if (action === 'states'){
      let ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok:false, error:'Falta ids[]' });
      const list = await loadNodes(subpanel); const allow = idSet(list);
      ids = ids.filter(id => allow.has(id));
      let capped = false;
      if (ids.length > STATES_MAX){ ids = ids.slice(0, STATES_MAX); capped = true; }
      const states = await readMany(token, subpanel, ids);
      return res.status(200).json({ ok:true, states, capped, max:STATES_MAX });
    }

    if (action === 'command'){
      const op = b.op; // on | off | dim
      if (!['on','off','dim'].includes(op)) return res.status(400).json({ ok:false, error:'op inválida' });
      let ids = (b.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok:false, error:'Falta ids[]' });
      if (op==='dim'){ const v = Number(b.value); if (isNaN(v) || v<0 || v>100) return res.status(400).json({ ok:false, error:'value 0-100' }); }
      const list = await loadNodes(subpanel); const allow = idSet(list);
      const bad = ids.filter(id => !allow.has(id));
      if (bad.length) return res.status(403).json({ ok:false, error:'ids fuera del subpanel: '+bad.join(',') });
      const out = await sendCommand(token, subpanel, op, b.value, ids);
      return res.status(200).json(Object.assign({ ok:true, op }, out));
    }

    return res.status(400).json({ ok:false, error:'Acción desconocida' });
  } catch (e){
    return res.status(502).json({ ok:false, error: e.message || 'Error en la pasarela' });
  }
}
