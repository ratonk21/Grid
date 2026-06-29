# Integrar optimo-SEN en griddata.cl

Tu repo ya trae `optimo-SEN/` vacío, `/api` con funciones ESM y
`package.json` con `"type":"module"`. Esto encaja sin tocar nada existente.

## 1. Copiar archivos (merge, no reemplazo)

```
griddata/
├── api/
│   ├── control.js              (ya existe)
│   ├── resumen-ia.js           (ya existe)
│   ├── scan-bill.mjs           (ya existe)
│   ├── ubicquia.js             (ya existe)
│   ├── sen-clasifica.js        ← AGREGAR
│   └── sen-sip.js              ← AGREGAR
├── optimo-SEN/
│   └── index.html              ← AGREGAR (la app)
└── optimo-SEN.env.example      ← AGREGAR (referencia)
```

No incluye `package.json` ni `vercel.json`: tu `package.json` (`type:module`)
ya sirve para los nuevos `.js`, y el sitio funciona zero-config. No agregues un
`vercel.json` o cambiarías el comportamiento del resto.

## 2. Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Estado | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | **ya existe** (resumen-ia / bill) | se reutiliza para `sen-clasifica` |
| `SEN_ACCESS_CODE` | agregar | gate de los dos conectores SEN |
| `SIP_USER_KEY` | agregar | clave de la API del Coordinador |
| `IA_MODEL` | opcional | override del modelo |
| `SIP_RECURSO` / `SIP_VERSION` | opcional | recurso/versión SIP por defecto |

## 3. Deploy

`git push` (auto-deploy) o `vercel --prod`. Queda en:

- App:  `https://griddata.cl/optimo-SEN/`
- IA:   `https://griddata.cl/api/sen-clasifica`
- SIP:  `https://griddata.cl/api/sen-sip`

## 4. Uso

En la app → pestaña **Datos & conector**: escribe el `SEN_ACCESS_CODE`,
pulsa **Probar conexión**. Si los puntos quedan verdes, ya puedes clasificar
motivos con IA y consultar el costo marginal real del SIP.

> Sin claves la app igual funciona: cargas datos a mano / por CSV y clasificas
> en modo local. El código de acceso solo habilita IA y SIP en vivo.

## Notas de seguridad (idénticas a tu patrón)
- Las claves viven solo en las funciones; nunca llegan al navegador.
- `x-access-code` con comparación timing-safe (`crypto.timingSafeEqual`).
- El front cae a modo local si el backend no responde (degradación elegante).
