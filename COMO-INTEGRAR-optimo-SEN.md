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
│   ├── sen-clasifica.js        ← AGREGAR (clasifica un motivo suelto)
│   ├── sen-extrae.js           ← AGREGAR (extrae limitaciones ambientales del PDF)
│   └── sen-sip.js              ← AGREGAR (costo marginal real del SIP)
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
| `ANTHROPIC_API_KEY` | **ya existe** (resumen-ia / bill) | se reutiliza para `sen-clasifica` y `sen-extrae` |
| `SEN_ALLOWED_ORIGINS` | agregar | restringe `/api/sen-*` a tu dominio (ej. https://griddata.cl) |
| `SIP_USER_KEY` | agregar (modo público) | clave user_key de la API del Coordinador |
| `SIP_CLIENT_ID` / `SIP_CLIENT_SECRET` | agregar (modo operacional) | OAuth client_credentials, si tu recurso requiere aprobación |
| `SIP_OP_BASE` | agregar (modo operacional) | base del servicio operacional (p.ej. mercados.api.coordinador.cl) |
| `IA_MODEL` | opcional | override del modelo |
| `SIP_RECURSO` / `SIP_VERSION` | opcional | recurso/versión SIP por defecto |

## 3. Deploy

`git push` (auto-deploy) o `vercel --prod`. Queda en:

- App:        `https://griddata.cl/optimo-SEN/`
- Clasifica:  `https://griddata.cl/api/sen-clasifica`
- Extrae:     `https://griddata.cl/api/sen-extrae`   (texto de sección PDF → limitaciones ambientales)
- SIP:        `https://griddata.cl/api/sen-sip`

## 4. Uso: reconstruir varios días

1. **Sube los PDF del Coordinador** (Informe Diario y Resumen Ejecutivo), uno o varios días.
   El navegador extrae el texto con PDF.js (no se sube el binario).
2. La app parsea la **tabla 1.1/1.2** (Prog./Real/Desv./Estado) → datos duros de energía.
3. En **Secciones detectadas**, pulsa **IA por sección** (o *Analizar todas*): cada sección
   3.2 / 3.5 / 4.1 / Justificación se manda a `/api/sen-extrae`, que devuelve **solo las
   limitaciones ambientales** ya clasificadas (SO2, NOx, MP, COx, Temp. Agua de Mar) y su decreto.
4. El **Resumen Ejecutivo** aporta el **costo marginal** (Quillota). También puedes traerlo del SIP.
5. **Evaluación** cruza limitación ambiental × energía desviada × costo marginal → MWh y USD por contaminante.

> Sin claves la app igual funciona: cargas datos a mano / por CSV y clasificas en modo local
> (el extractor cae a un troceo por regex). Con `ANTHROPIC_API_KEY` y `SIP_USER_KEY` se activan
> el extractor IA y el costo marginal en vivo.

## Notas de seguridad
- Las claves viven solo en las funciones serverless; nunca llegan al navegador.
- Acceso a `/api/sen-*` restringido por **origen** (`SEN_ALLOWED_ORIGINS`), no por código visible.
- Origin/Referer es falsificable por clientes que no son navegadores: para blindaje fuerte,
  suma **rate-limit** (Vercel WAF) sobre `/api/sen-*`.
- El front cae a modo local si el backend no responde (degradación elegante).
