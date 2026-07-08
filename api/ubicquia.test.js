import { describe, it, expect } from 'vitest';
import {
  pageSignature,
  normalizePanel,
  safelyParseJson,
  addMsgFields,
  filterPowerLoss,
  filterPowerRestored,
} from './ubicquia.js';

// pageSignature detiene la paginación al detectar una página repetida.
// Un fallo aquí provoca paginación infinita o pérdida silenciosa de datos.
describe('pageSignature (guarda de completitud de datos)', () => {
  it('produce firma estable para las mismas filas', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(pageSignature(rows)).toBe(pageSignature(rows));
    expect(pageSignature(rows)).toBe('3|1|3');
  });

  it('cambia cuando cambia el tamaño o el primer/último id', () => {
    expect(pageSignature([{ id: 1 }, { id: 2 }])).not.toBe(pageSignature([{ id: 1 }, { id: 3 }]));
    expect(pageSignature([{ id: 1 }])).not.toBe(pageSignature([{ id: 1 }, { id: 2 }]));
  });

  it('cae a createdAt/date/dev_eui cuando no hay id', () => {
    expect(pageSignature([{ createdAt: 'a' }, { createdAt: 'b' }])).toBe('2|a|b');
    expect(pageSignature([{ dev_eui: 'X' }])).toBe('1|X|X');
  });

  it('maneja el arreglo vacío sin lanzar', () => {
    expect(pageSignature([])).toBe('0||');
  });
});

// normalizePanel resuelve el id de panel con default.
describe('normalizePanel', () => {
  it('usa el panel por defecto cuando falta', () => {
    expect(normalizePanel(undefined)).toBe('646703');
    expect(normalizePanel(null)).toBe('646703');
    expect(normalizePanel('')).toBe('646703');
  });

  it('recorta espacios y convierte números a string', () => {
    expect(normalizePanel('  803  ')).toBe('803');
    expect(normalizePanel(1494)).toBe('1494');
  });
});

// safelyParseJson debe recuperarse de JSON malformado (comillas tipográficas) sin lanzar.
describe('safelyParseJson (parseo robusto)', () => {
  it('deja pasar objetos tal cual', () => {
    const o = { a: 1 };
    expect(safelyParseJson(o)).toBe(o);
  });

  it('parsea JSON válido', () => {
    expect(safelyParseJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('recupera JSON con comillas tipográficas', () => {
    expect(safelyParseJson('{“a”:1}')).toEqual({ a: 1 });
  });

  it('devuelve {} para null, undefined y basura', () => {
    expect(safelyParseJson(null)).toEqual({});
    expect(safelyParseJson(undefined)).toEqual({});
    expect(safelyParseJson('no soy json')).toEqual({});
  });
});

// addMsgFields extrae MsgStr/MsgType desde la columna jsonData.
describe('addMsgFields', () => {
  it('agrega MsgStr y MsgType parseados desde jsonData', () => {
    const [row] = addMsgFields([{ jsonData: '{"msgStr":"AlertPowerLoss","msgType":"alarm"}', dev_eui: 'A' }]);
    expect(row.MsgStr).toBe('AlertPowerLoss');
    expect(row.MsgType).toBe('alarm');
    expect(row.dev_eui).toBe('A'); // conserva campos originales
  });

  it('no lanza cuando jsonData es inválido', () => {
    const [row] = addMsgFields([{ jsonData: 'roto' }]);
    expect(row.MsgStr).toBeUndefined();
  });
});

// Clasificación de eventos de pérdida/restauración de energía.
describe('filterPowerLoss / filterPowerRestored', () => {
  const rows = [
    { jsonData: '{"msgStr":"AlertPowerLoss"}' },
    { jsonData: '{"msgStr":"AlertPowerLoss2"}' },
    { jsonData: '{"msgStr":"AlertPowerRestored"}' },
    { alertvalue: 'Loss' },
    { alertvalue: 'Restored' },
    { jsonData: '{"msgStr":"OtraCosa"}' },
  ];

  it('filterPowerLoss captura AlertPowerLoss, AlertPowerLoss2 y alertvalue Loss', () => {
    const out = filterPowerLoss(rows);
    expect(out).toHaveLength(3);
    expect(out.every(r => ['AlertPowerLoss', 'AlertPowerLoss2'].includes(r.MsgStr) || r.alertvalue === 'Loss')).toBe(true);
  });

  it('filterPowerRestored captura AlertPowerRestored y alertvalue Restored', () => {
    const out = filterPowerRestored(rows);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.MsgStr === 'AlertPowerRestored' || r.alertvalue === 'Restored')).toBe(true);
  });

  it('excluye eventos que no coinciden', () => {
    expect(filterPowerLoss([{ jsonData: '{"msgStr":"OtraCosa"}' }])).toHaveLength(0);
  });
});
