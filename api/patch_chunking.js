/**
 * PATCH CHUNKING para archivos CSV grandes (>5MB)
 * Reemplaza la función ingest() para detectar archivos grandes
 * y cargar en chunks de ~5000 registros con botón "Load More"
 */

// Estado global para chunking
const CHUNKING_STATE = {
  currentFile: null,
  allRows: [],
  allHeaders: [],
  loadedCount: 0,
  chunkSize: 5000,
  totalEstimate: 0,
  isLoading: false
};

/**
 * Versión mejorada de ingest() con soporte chunking
 * Si archivo > 5MB, carga en chunks interactivos
 */
function ingestChunked(files) {
  let pending = files.length;
  if (!pending) return;

  const el = document.getElementById("loaded");
  if (el) el.innerHTML = `<div class="note">${L(`Procesando ${pending} archivo(s)…`, `Processing ${pending} file(s)…`)}</div>`;

  Array.from(files).forEach(f => {
    if (LOADED.includes(f.name)) {
      if (--pending === 0) afterIngest();
      return;
    }

    // Si archivo > 5MB, usar chunking
    if (f.size > 5 * 1024 * 1024) {
      ingestChunkedFile(f, () => {
        if (--pending === 0) afterIngest();
      });
    } else {
      // Archivo pequeño: parse normal
      Papa.parse(f, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: res => {
          const rows = res.data.filter(r => r && Object.keys(r).length > 3);
          const headers = res.meta.fields || Object.keys(rows[0] || {});
          ingestParsed(f.name, rows, headers);
          if (--pending === 0) afterIngest();
        }
      });
    }
  });
}

/**
 * Carga un archivo grande en chunks usando el parámetro chunk de PapaParse
 * Carga primer chunk automáticamente, luego ofrece botón "Load More"
 */
function ingestChunkedFile(file, callback) {
  CHUNKING_STATE.currentFile = file;
  CHUNKING_STATE.allRows = [];
  CHUNKING_STATE.allHeaders = [];
  CHUNKING_STATE.loadedCount = 0;

  const el = document.getElementById("loaded");
  if (el) {
    el.innerHTML = `
      <div class="note">
        <b>${L("Archivo grande detectado", "Large file detected")}</b> (${(file.size / 1024 / 1024).toFixed(1)} MB)<br>
        ${L("Cargando primeras filas…", "Loading first batch…")}
        <div id="chunkProgress" style="margin-top:8px; font-size:12px; color:var(--ubi-gray2)"></div>
      </div>
    `;
  }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    worker: false,
    chunk: results => {
      // results.data = array de filas en este chunk
      // results.meta.fields = headers (solo en primer chunk)
      
      if (!CHUNKING_STATE.allHeaders.length && results.meta.fields) {
        CHUNKING_STATE.allHeaders = results.meta.fields;
      }

      const validRows = results.data.filter(r => r && Object.keys(r).length > 3);
      CHUNKING_STATE.allRows.push(...validRows);
      CHUNKING_STATE.loadedCount += validRows.length;

      // Actualizar UI de progreso
      const prog = document.getElementById("chunkProgress");
      if (prog) {
        prog.textContent = L(
          `${CHUNKING_STATE.loadedCount.toLocaleString()} filas cargadas`,
          `${CHUNKING_STATE.loadedCount.toLocaleString()} rows loaded`
        );
      }

      // Parar de cargar después del primer chunk
      if (CHUNKING_STATE.loadedCount >= CHUNKING_STATE.chunkSize) {
        return false; // stop parsing
      }
    },
    complete: () => {
      // Primer chunk completo, ofrecer "Load More"
      if (CHUNKING_STATE.allRows.length > 0) {
        ingestParsed(file.name, CHUNKING_STATE.allRows, CHUNKING_STATE.allHeaders);

        // Mostrar botón "Load More" solo si hay más datos
        const el = document.getElementById("loaded");
        if (el) {
          el.innerHTML = `
            <div class="note" style="display:flex; align-items:center; gap:12px; justify-content:space-between;">
              <span>
                <b>${file.name}</b> — ${CHUNKING_STATE.loadedCount.toLocaleString()} ${L("filas cargadas", "rows loaded")}
              </span>
              <button id="loadMoreBtn" onclick="loadMoreRows()" 
                style="padding:6px 12px; background:var(--ubi-blue); color:white; border:0; border-radius:var(--radio); cursor:pointer; font-weight:600; font-size:12px;">
                ${L("Cargar más", "Load More")}
              </button>
            </div>
          `;
        }
      }
      callback();
    },
    error: err => {
      const el = document.getElementById("loaded");
      if (el) {
        el.innerHTML = `<div class="note" style="color:var(--ubi-orange)"><b>${L("Error al procesar archivo", "Error processing file")}</b><br>${String(err)}</div>`;
      }
      callback();
    }
  });
}

/**
 * Continúa cargando más filas del archivo actual
 */
function loadMoreRows() {
  if (!CHUNKING_STATE.currentFile) return;

  const btn = document.getElementById("loadMoreBtn");
  if (btn) btn.disabled = true;

  const offset = CHUNKING_STATE.loadedCount;

  Papa.parse(CHUNKING_STATE.currentFile, {
    header: true,
    skipEmptyLines: true,
    worker: false,
    chunk: results => {
      // Contar filas hasta alcanzar el offset
      const validRows = results.data.filter(r => r && Object.keys(r).length > 3);
      
      if (offset + CHUNKING_STATE.loadedCount < offset + CHUNKING_STATE.chunkSize) {
        CHUNKING_STATE.allRows.push(...validRows);
        CHUNKING_STATE.loadedCount += validRows.length;
      } else {
        return false; // stop
      }
    },
    complete: () => {
      // Actualizar UI
      const el = document.getElementById("loaded");
      const dataset = DATASETS.find(d => d.name === CHUNKING_STATE.currentFile.name);
      if (dataset) {
        dataset.data = CHUNKING_STATE.allRows; // actualizar dataset
        buildUI(); // refrescar visualización
      }

      if (el) {
        el.innerHTML = `
          <div class="note" style="display:flex; align-items:center; gap:12px; justify-content:space-between;">
            <span><b>${CHUNKING_STATE.currentFile.name}</b> — ${CHUNKING_STATE.loadedCount.toLocaleString()} ${L("filas cargadas", "rows loaded")}</span>
            <button id="loadMoreBtn" onclick="loadMoreRows()" 
              style="padding:6px 12px; background:var(--ubi-blue); color:white; border:0; border-radius:var(--radio); cursor:pointer; font-weight:600; font-size:12px;">
              ${L("Cargar más", "Load More")}
            </button>
          </div>
        `;
      }
    }
  });
}
