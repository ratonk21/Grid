// /api/licitaciones.js  —  Proxy seguro a la API pública de Mercado Público.
//
// Por qué existe esta función (y no se llama la API desde el navegador):
//   1) El ticket es secreto y tiene tope de 10.000 solicitudes/día. Vive aquí
//      como variable de entorno (MP_TICKET), nunca en el HTML.
//   2) api.mercadopublico.cl no manda cabeceras CORS, así que el navegador no
//      puede llamarla directo. Esta función sí, y le devuelve JSON ya normalizado
//      al front.
//
// La API de Mercado Público NO tiene filtro por comuna, así que esta función
// implementa varios modos:
//   modo=comprador  -> RECOMENDADO. Busca por CodigoOrganismo (parámetro oficial)
//                      sobre un rango de días. Preciso y acotado al organismo.
//   modo=resolver   -> dado un RUT y/o nombre, busca el/los CodigoOrganismo con
//                      BuscarComprador (para descubrir el código de una comuna).
//   modo=organismo  -> trae estado=activas (1 llamada) y filtra por el prefijo
//                      del CodigoExterno (el ID del organismo comprador).
//   modo=comuna     -> trae el listado por día(s), pide el detalle de cada una
//                      y filtra por ComunaUnidad. Más caro: acotado por días y tope.
//
// Parámetros (query string):
//   modo        organismo | comuna           (default: comuna)
//   comuna      nombre de la comuna          (modo comuna)
//   region      nombre de la región opcional (modo comuna, filtro extra)
//   organismos  prefijos CSV ej "1509,801"   (modo organismo)
//   estado      activas|publicada|cerrada|adjudicada|desierta|revocada|suspendida|todos
//   dias        cuántos días hacia atrás enriquecer (modo comuna, default 7, máx 31)
//   max         tope de detalles a pedir por consulta (default 600, máx 3000)
//
// Notas de límite: el modo comuna gasta ~1 llamada por licitación del día. Para
// uso intensivo conviene un cron diario que acumule en un store; ver README.

const API = 'https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json';
const BUSCAR_COMPRADOR = 'https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador';
const FICHA = 'https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=';

const ESTADOS = {
  '5': 'Publicada', '6': 'Cerrada', '7': 'Desierta',
  '8': 'Adjudicada', '18': 'Revocada', '19': 'Suspendida',
};

// Caché en memoria: vive mientras la lambda esté "caliente". Evita repetir
// llamadas idénticas en ráfaga. (Para caché persistente usar Vercel KV; ver README.)
const cache = new Map();
const TTL = 10 * 60 * 1000; // 10 min

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  cache.delete(key);
  return null;
}
function cacheSet(key, v) {
  cache.set(key, { v, t: Date.now() });
}

// Normaliza texto para comparar comunas sin tildes ni mayúsculas.
function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// ddmmaaaa para un día N hacia atrás desde hoy (hora de Chile aproximada).
function fechaHaceDias(n) {
  const d = new Date(Date.now() - n * 86400000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

// fetch con timeout y validación de que la respuesta sea JSON (la API a veces
// devuelve una página de error en HTML cuando algo va mal).
async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('Respuesta no-JSON de Mercado Público (¿ticket inválido o límite excedido?)');
      err.status = 502;
      err.body = text.slice(0, 300);
      throw err;
    }
  } finally {
    clearTimeout(id);
  }
}

// Ejecuta tareas async con concurrencia limitada (para no abrir 600 sockets).
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Aplana un item (liviano o detallado) a la forma que consume el front.
function aplanar(it) {
  const comprador = it.Comprador || {};
  const fechas = it.Fechas || {};
  return {
    codigo: it.CodigoExterno || '',
    nombre: it.Nombre || '',
    estado: String(it.CodigoEstado ?? ''),
    estadoTxt: ESTADOS[String(it.CodigoEstado)] || it.Estado || '—',
    organismo: comprador.NombreOrganismo || '',
    unidad: comprador.NombreUnidad || '',
    region: comprador.RegionUnidad || '',
    comuna: comprador.ComunaUnidad || '',
    fechaPublicacion: fechas.FechaPublicacion || it.FechaPublicacion || '',
    fechaCierre: fechas.FechaCierre || it.FechaCierre || '',
    monto: it.MontoEstimado ?? null,
    moneda: it.Moneda || '',
    tipo: it.Tipo || '',
    prefijo: (it.CodigoExterno || '').split('-')[0] || '',
    url: it.CodigoExterno ? FICHA + encodeURIComponent(it.CodigoExterno) : '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // por si se prueba en local
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  const ticket = process.env.MP_TICKET;
  if (!ticket) {
    res.status(500).json({ ok: false, error: 'Falta MP_TICKET en variables de entorno de Vercel.' });
    return;
  }

  const q = req.query || {};
  const modo = (q.modo || 'comuna').toString();
  const estado = (q.estado || 'activas').toString();
  let stats = { llamadas: 0, evaluadas: 0, modo, estado };

  try {
    // ---------- MODO RESOLVER: RUT/nombre -> CodigoOrganismo ----------
    if (modo === 'resolver') {
      const rutDigits = norm(q.rut).replace(/[^0-9k]/g, '');
      const nombre = norm(q.nombre);
      if (!rutDigits && !nombre) {
        res.status(400).json({ ok: false, error: 'modo=resolver requiere ?rut= y/o ?nombre=' });
        return;
      }
      const key = 'compradores:all';
      let data = cacheGet(key);
      if (!data) { data = await getJSON(`${BUSCAR_COMPRADOR}?ticket=${ticket}`, 60000); stats.llamadas++; cacheSet(key, data); }
      const lista = Array.isArray(data.Listado) ? data.Listado : [];
      const matches = lista.filter(o => {
        const n = norm(o.NombreEmpresa || o.Nombre || '');
        const r = norm(o.RutSucursal || o.RutEmpresa || o.Rut || '').replace(/[^0-9k]/g, '');
        var ok = false;
        if (rutDigits && r) ok = ok || (r === rutDigits);
        if (nombre) ok = ok || n.includes(nombre);
        return ok;
      }).map(o => ({ codigo: String(o.CodigoEmpresa ?? o.Codigo ?? ''), nombre: o.NombreEmpresa || o.Nombre || '' }))
        .filter(m => m.codigo);
      res.status(200).json({ ok: true, total: matches.length, stats, compradores: matches });
      return;
    }

    // ---------- MODO COMPRADOR: por CodigoOrganismo (oficial) ----------
    if (modo === 'comprador') {
      const codes = (q.organismos || '').toString().split(',').map(s => s.trim()).filter(Boolean);
      if (!codes.length) {
        res.status(400).json({ ok: false, error: 'modo=comprador requiere ?organismos=codigo1,codigo2' });
        return;
      }
      const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 1), 60);
      // Estado pedido -> set de CodigoEstado a conservar (vacío = todos).
      const mapEstado = { activas: ['5'], publicada: ['5'], cerrada: ['6'], desierta: ['7'], adjudicada: ['8'], revocada: ['18'], suspendida: ['19'] };
      const quiere = mapEstado[estado] || null;

      const vistos = new Set();
      const livianas = [];
      for (let d = 0; d < dias; d++) {
        const fecha = fechaHaceDias(d);
        for (const code of codes) {
          const key = `org:${fecha}:${code}`;
          let data = cacheGet(key);
          if (!data) {
            const url = `${API}?fecha=${fecha}&CodigoOrganismo=${encodeURIComponent(code)}&ticket=${ticket}`;
            try { data = await getJSON(url); stats.llamadas++; cacheSet(key, data); }
            catch { data = { Listado: [] }; }
          }
          for (const it of (data.Listado || [])) {
            const c = it.CodigoExterno;
            if (c && !vistos.has(c)) { vistos.add(c); livianas.push(it); }
          }
        }
      }
      stats.evaluadas = livianas.length;

      // Enriquecer todo (ya es chico, acotado al organismo) y filtrar por estado.
      const detalladas = await mapPool(livianas, 6, async (it) => {
        const key = `det:${it.CodigoExterno}`;
        let dd = cacheGet(key);
        if (!dd) {
          const url = `${API}?codigo=${encodeURIComponent(it.CodigoExterno)}&ticket=${ticket}`;
          dd = await getJSON(url); stats.llamadas++; cacheSet(key, dd);
        }
        return (dd.Listado && dd.Listado[0]) || null;
      });
      let filtradas = detalladas.filter(Boolean).map(aplanar);
      if (quiere) filtradas = filtradas.filter(f => quiere.indexOf(f.estado) !== -1);
      const prefijosDetectados = [...new Set(filtradas.map(f => f.prefijo).filter(Boolean))];
      res.status(200).json({ ok: true, total: filtradas.length, prefijosDetectados, stats, licitaciones: filtradas });
      return;
    }

    // ---------- MODO ORGANISMO: rápido, 1 llamada ----------
    if (modo === 'organismo') {
      const prefijos = (q.organismos || '')
        .toString().split(',').map(s => s.trim()).filter(Boolean);
      if (!prefijos.length) {
        res.status(400).json({ ok: false, error: 'modo=organismo requiere ?organismos=prefijo1,prefijo2' });
        return;
      }
      const url = `${API}?estado=${encodeURIComponent(estado)}&ticket=${ticket}`;
      const key = `list:${estado}`;
      let data = cacheGet(key);
      if (!data) { data = await getJSON(url); stats.llamadas++; cacheSet(key, data); }
      const listado = Array.isArray(data.Listado) ? data.Listado : [];
      stats.evaluadas = listado.length;
      const setpref = new Set(prefijos);
      const filtradas = listado
        .filter(it => setpref.has((it.CodigoExterno || '').split('-')[0]))
        .map(aplanar);
      res.status(200).json({ ok: true, total: filtradas.length, stats, licitaciones: filtradas });
      return;
    }

    // ---------- MODO COMUNA: preciso, enriquece con detalle ----------
    const comuna = norm(q.comuna);
    const region = norm(q.region);
    if (!comuna) {
      res.status(400).json({ ok: false, error: 'modo=comuna requiere ?comuna=Nombre' });
      return;
    }
    const dias = Math.min(Math.max(parseInt(q.dias, 10) || 7, 1), 31);
    const max = Math.min(Math.max(parseInt(q.max, 10) || 600, 1), 3000);

    // 1) Junta el listado liviano de los últimos `dias` días (dedup por código).
    const vistos = new Set();
    const livianas = [];
    for (let d = 0; d < dias; d++) {
      const fecha = fechaHaceDias(d);
      const key = `day:${fecha}:${estado}`;
      let data = cacheGet(key);
      if (!data) {
        const url = `${API}?fecha=${fecha}&estado=${encodeURIComponent(estado)}&ticket=${ticket}`;
        try { data = await getJSON(url); stats.llamadas++; cacheSet(key, data); }
        catch { data = { Listado: [] }; } // un día que falle no rompe el resto
      }
      for (const it of (data.Listado || [])) {
        const c = it.CodigoExterno;
        if (c && !vistos.has(c)) { vistos.add(c); livianas.push(it); }
      }
    }
    stats.evaluadas = livianas.length;

    // 2) Enriquece con detalle (acotado por `max`) y filtra por comuna/región.
    const objetivo = livianas.slice(0, max);
    const truncado = livianas.length > max;
    const detalladas = await mapPool(objetivo, 6, async (it) => {
      const key = `det:${it.CodigoExterno}`;
      let d = cacheGet(key);
      if (!d) {
        const url = `${API}?codigo=${encodeURIComponent(it.CodigoExterno)}&ticket=${ticket}`;
        d = await getJSON(url); stats.llamadas++; cacheSet(key, d);
      }
      return (d.Listado && d.Listado[0]) || null;
    });

    const filtradas = detalladas
      .filter(Boolean)
      .filter(it => {
        const cmp = it.Comprador || {};
        if (norm(cmp.ComunaUnidad) !== comuna) return false;
        if (region && norm(cmp.RegionUnidad) !== region) return false;
        return true;
      })
      .map(aplanar);

    // Prefijos de organismo detectados en esta comuna (para pasar a modo rápido).
    const prefijosDetectados = [...new Set(filtradas.map(f => f.prefijo).filter(Boolean))];

    res.status(200).json({
      ok: true,
      total: filtradas.length,
      truncado,
      prefijosDetectados,
      stats,
      licitaciones: filtradas,
    });
  } catch (e) {
    res.status(e.status === 429 ? 429 : 502).json({
      ok: false,
      error: e.message || 'Error consultando Mercado Público',
      detalle: e.body || null,
      stats,
    });
  }
}
