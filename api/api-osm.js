// /api/osm.js — proxy Overpass para circuito-gt (griddata.cl)
// Servidor-a-servidor: sin CORS del lado Overpass, User-Agent correcto
// (evita el filtro anti-bot 406 de overpass-api.de) y cache de borde 7 dias:
// tras el primer exito, el juego carga al tiro y queda inmune a caidas.
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

export default async function handler(req, res) {
  const q = (req.query.data || '').toString();
  // solo queries out:json chicas (las del juego): nada de abuso via proxy
  if (!q || q.length > 4000 || !/^\[out:json\]/.test(q)) {
    res.status(400).json({ error: 'query invalida' });
    return;
  }
  let last = 'sin respuesta';
  for (const m of MIRRORS) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(m + '?data=' + encodeURIComponent(q), {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'griddata-circuito-gt/1.0 (+https://griddata.cl; contacto en el sitio)'
        },
        signal: ctrl.signal
      });
      clearTimeout(to);
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      const js = await r.json();
      if (!js.elements || js.elements.length === 0) { last = js.remark || 'vacio'; continue; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=86400');
      res.status(200).json(js);
      return;
    } catch (e) { last = 'timeout/red'; }
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(502).json({ error: 'overpass no disponible: ' + last });
}
