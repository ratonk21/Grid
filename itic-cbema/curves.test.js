import { describe, it, expect } from 'vitest';
import {
  ITIC,
  cleanNum,
  colGet,
  median,
  durToSeconds,
  inferUnit,
  interpCurveY,
  classifyPoint,
  rowKind,
  bucketRows,
  buildEvents,
  summarize,
  parseTimeOfDay,
  countBucketLabel,
} from './curves.js';

// interpCurveY: interpolación log-lineal sobre las curvas ITIC/CBEMA (staircase).
// Un error aquí cambia el veredicto de cumplimiento de calidad de energía.
describe('interpCurveY (interpolación sobre curva)', () => {
  it('satura por debajo del primer punto al valor inicial', () => {
    expect(interpCurveY(1e-9, ITIC.PROH_X, ITIC.PROH_Y)).toBe(500);
  });
  it('satura por encima del último punto al valor final', () => {
    expect(interpCurveY(5000, ITIC.PROH_X, ITIC.PROH_Y)).toBe(110);
  });
  it('devuelve el tramo plano correcto en el interior (PROH @0.1s = 120)', () => {
    expect(interpCurveY(0.1, ITIC.PROH_X, ITIC.PROH_Y)).toBe(120);
  });
  it('devuelve el tramo plano correcto de la curva FREE (@0.1s = 70)', () => {
    expect(interpCurveY(0.1, ITIC.FREE_X, ITIC.FREE_Y)).toBe(70);
  });
});

// classifyPoint clasifica un punto (duración, magnitud%) en free/normal/prohibited.
describe('classifyPoint (clasificación por zona)', () => {
  it('clasifica como free cuando la magnitud está por debajo de la curva de no-daño', () => {
    expect(classifyPoint(0.1, 50)).toBe('free'); // yN=70, yF=120
  });
  it('clasifica como normal entre las dos curvas', () => {
    expect(classifyPoint(0.1, 90)).toBe('normal');
  });
  it('clasifica como prohibited por encima de la curva prohibida', () => {
    expect(classifyPoint(0.1, 200)).toBe('prohibited');
  });
  it('un swell corto y profundo cae en prohibited', () => {
    expect(classifyPoint(1e-3, 600)).toBe('prohibited'); // yN=0, yF=500
    expect(classifyPoint(1e-3, 300)).toBe('normal');
  });
});

describe('durToSeconds (conversión de duración a segundos)', () => {
  it('convierte ciclos usando la frecuencia', () => {
    expect(durToSeconds(60, 'cycles', 60)).toBe(1);
    expect(durToSeconds(30, 'cycles', 50)).toBe(0.6);
  });
  it('convierte us, ms y s', () => {
    expect(durToSeconds(1e6, 'us')).toBe(1);
    expect(durToSeconds(500, 'ms')).toBe(0.5);
    expect(durToSeconds(2, 's')).toBe(2);
  });
  it('unidad desconocida cae a ciclos (d/F) y NaN se propaga', () => {
    expect(durToSeconds(60, 'zzz', 60)).toBe(1);
    expect(durToSeconds(NaN, 's')).toBeNaN();
  });
});

describe('median', () => {
  it('mediana de longitud impar', () => expect(median([3, 1, 2])).toBe(2));
  it('mediana de longitud par (promedia el centro)', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it('filtra no-finitos', () => expect(median([5, NaN, 1])).toBe(3));
  it('arreglo vacío → NaN', () => expect(median([])).toBeNaN());
});

describe('inferUnit (inferencia de unidad por magnitud típica)', () => {
  it('valores pequeños → ciclos', () => expect(inferUnit([10, 20, 30])).toBe('cycles'));
  it('valores grandes (> umbral) → microsegundos', () => expect(inferUnit([1e5, 2e5])).toBe('us'));
  it('sin datos → ciclos por defecto', () => expect(inferUnit([])).toBe('cycles'));
});

describe('cleanNum (parseo numérico robusto)', () => {
  it('pasa números y parsea strings', () => {
    expect(cleanNum(5)).toBe(5);
    expect(cleanNum('96.15')).toBe(96.15);
  });
  it('acepta coma decimal y descarta unidades', () => {
    expect(cleanNum('1,5')).toBe(1.5);
    expect(cleanNum('12 V')).toBe(12);
  });
  it('vacío, null y basura → NaN', () => {
    expect(cleanNum('')).toBeNaN();
    expect(cleanNum(null)).toBeNaN();
    expect(cleanNum('abc')).toBeNaN();
  });
});

describe('colGet (lookup de columna, insensible a mayúsculas y espacios)', () => {
  it('encuentra por nombre insensible a mayúsculas', () => {
    expect(colGet({ 'Node Name': 'T1' }, ['node name'])).toBe('T1');
  });
  it('recorta espacios en las claves', () => {
    expect(colGet({ ' X1 Duration ': 5 }, ['X1 Duration'])).toBe(5);
  });
  it('prueba candidatos en orden y devuelve undefined si ninguno coincide', () => {
    expect(colGet({ A: 1 }, ['B', 'A'])).toBe(1);
    expect(colGet({ A: 1 }, ['Z'])).toBeUndefined();
    expect(colGet(null, ['x'])).toBeUndefined();
  });
});

describe('rowKind (clasifica fila por Template Name / Event Type)', () => {
  it('detecta sag, swell y power', () => {
    expect(rowKind({ 'Template Name': 'Vsag' })).toBe('sag');
    expect(rowKind({ 'Template Name': 'Vswell' })).toBe('swell');
    expect(rowKind({ 'Template Name': 'Power Status' })).toBe('power');
  });
  it('devuelve null cuando no coincide', () => {
    expect(rowKind({ 'Template Name': 'foo' })).toBe(null);
  });
});

describe('bucketRows (agrupa filas por tipo)', () => {
  it('agrupa por contenido (Template Name)', () => {
    const b = bucketRows([{ name: 'x.csv', rows: [{ 'Template Name': 'Vsag' }, { 'Template Name': 'Vswell' }] }]);
    expect(b.sag).toHaveLength(1);
    expect(b.swell).toHaveLength(1);
    expect(b.power).toHaveLength(0);
  });
  it('cae al nombre de archivo cuando el contenido no clasifica', () => {
    const b = bucketRows([{ name: 'powerloss.csv', rows: [{ foo: 'bar' }] }]);
    expect(b.power).toHaveLength(1);
  });
});

describe('parseTimeOfDay (hora del día → bin de 5 min, 0..287)', () => {
  it('interpreta AM/PM de 12 horas', () => {
    expect(parseTimeOfDay('06/21/2026 05:26:07 PM')).toBe(17 * 12 + 5); // 17:25 → 209
    expect(parseTimeOfDay('12:00 AM')).toBe(0);
    expect(parseTimeOfDay('12:00 PM')).toBe(144);
  });
  it('interpreta 24 horas', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('13:05')).toBe(157);
  });
  it('devuelve -1 sin hora legible', () => {
    expect(parseTimeOfDay('')).toBe(-1);
    expect(parseTimeOfDay(null)).toBe(-1);
    expect(parseTimeOfDay('sin hora')).toBe(-1);
  });
});

describe('countBucketLabel (índice de bin → etiqueta HH:MM)', () => {
  it('formatea correctamente', () => {
    expect(countBucketLabel(0)).toBe('00:00');
    expect(countBucketLabel(209)).toBe('17:25');
    expect(countBucketLabel(287)).toBe('23:55');
  });
});

// Pipeline completo: buildEvents + summarize sobre filas tipo DTM.
describe('buildEvents + summarize (pipeline de análisis)', () => {
  const sagRows = [{
    'X1 Lowest Value': '60', 'X1 Duration': '60',
    'X3 Lowest Value': '120', 'X3 Duration': '120',
    'Nominal Voltage': '120', Date: 't1',
  }];

  it('genera eventos por fase con magnitud y zona correctas', () => {
    const be = buildEvents(sagRows, [], { ref: 120, freq: 60, durUnit: 'cycles' });
    expect(be.events).toHaveLength(2); // X1 y X3 (X2 sin valor → descartado)
    const x1 = be.events.find(e => e.Phase === 'X1');
    const x3 = be.events.find(e => e.Phase === 'X3');
    expect(x1.MagPct).toBe(50); // 60/120*100
    expect(x1.DurationS).toBe(1); // 60 ciclos @60Hz
    expect(x1.Zone).toBe('free');
    expect(x3.MagPct).toBe(100);
    expect(x3.Zone).toBe('normal');
    expect(be.detected.SAG).toEqual({ X1: 1, X2: 0, X3: 1 });
    expect(be.dropped).toBe(0);
    expect(be.unitUsed.SAG).toBe('cycles');
  });

  it('summarize agrega totales, zonas y fases', () => {
    const be = buildEvents(sagRows, [], { ref: 120, freq: 60, durUnit: 'cycles' });
    const s = summarize(be.events, 0, be.detected, be.unitUsed);
    expect(s.total).toBe(2);
    expect(s.sag).toBe(2);
    expect(s.swell).toBe(0);
    expect(s.zones).toEqual({ free: 1, normal: 1, prohibited: 0 });
    expect(s.byPhase).toEqual({ X1: 1, X2: 0, X3: 1 });
  });

  it('usa el nominal de respaldo (ref) cuando la fila no trae Nominal Voltage', () => {
    const rows = [{ 'X1 Lowest Value': '100', 'X1 Duration': '60' }];
    const be = buildEvents(rows, [], { ref: 200, freq: 60, durUnit: 'cycles' });
    expect(be.events[0].Nominal).toBe(200);
    expect(be.events[0].MagPct).toBe(50); // 100/200*100
  });
});
