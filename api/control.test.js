import { describe, it, expect } from 'vitest';
import { mapState, scopeAllows, normSubs, scopeOf } from './control.js';

// scopeAllows es la puerta de autorización de control de dispositivos: qué acción
// puede ejecutar cada ámbito (control/reboot). Un fallo aquí deja pasar comandos
// que no deberían permitirse.
describe('scopeAllows (puerta de autorización)', () => {
  it('el ámbito control puede comandar luminarias pero no reiniciar', () => {
    expect(scopeAllows('control', 'command')).toBe(true);
    expect(scopeAllows('control', 'state')).toBe(true);
    expect(scopeAllows('control', 'reboot')).toBe(false);
  });

  it('el ámbito reboot puede reiniciar pero no comandar', () => {
    expect(scopeAllows('reboot', 'reboot')).toBe(true);
    expect(scopeAllows('reboot', 'command')).toBe(false);
  });

  it('rechaza ámbitos desconocidos y acciones desconocidas', () => {
    expect(scopeAllows('nope', 'state')).toBe(false);
    expect(scopeAllows('control', 'desconocida')).toBe(false);
    expect(scopeAllows(null, 'state')).toBe(false);
    expect(scopeAllows(undefined, undefined)).toBe(false);
  });
});

// mapState decodifica el estado de la luz (encendido/apagado/dim) desde el nodo.
describe('mapState (decodificación de estado)', () => {
  it('decodifica ON/OFF/desconocido en power true/false/null', () => {
    expect(mapState({ light_status: 'ON' }).power).toBe(true);
    expect(mapState({ light_status: 'off' }).power).toBe(false); // insensible a mayúsculas
    expect(mapState({ light_status: '?' }).power).toBe(null);
    expect(mapState({}).power).toBe(null);
  });

  it('devuelve {found:false} para un nodo nulo', () => {
    expect(mapState(null)).toEqual({ found: false });
    expect(mapState(undefined)).toEqual({ found: false });
  });

  it('convierte LD1State (string o número) a dim numérico, o null si falta', () => {
    expect(mapState({ LD1State: '42' }).dim).toBe(42);
    expect(mapState({ LD1State: 0 }).dim).toBe(0);
    expect(mapState({}).dim).toBe(null);
  });

  it('m.on refleja el estado de encendido (1/0)', () => {
    expect(mapState({ light_status: 'ON' }).m.on).toBe(1);
    expect(mapState({ light_status: 'OFF' }).m.on).toBe(0);
    expect(mapState({ light_status: '?' }).m.on).toBe(0);
  });

  it('nodeStatus usa node_status y cae a state', () => {
    expect(mapState({ node_status: 'online' }).nodeStatus).toBe('online');
    expect(mapState({ state: 'active' }).nodeStatus).toBe('active');
    expect(mapState({}).nodeStatus).toBe(null);
  });
});

// normSubs normaliza la lista de subpaneles a { id, name } con id string.
describe('normSubs (normalización de subpaneles)', () => {
  it('convierte elementos string en {id,name} con id string', () => {
    expect(normSubs(['437', 930])).toEqual([
      { id: '437', name: '437' },
      { id: '930', name: '930' },
    ]);
  });

  it('preserva el name de elementos objeto y cae al id cuando falta', () => {
    expect(normSubs([{ id: 1, name: 'Centro' }, { id: 2 }])).toEqual([
      { id: '1', name: 'Centro' },
      { id: '2', name: '2' },
    ]);
  });

  it('devuelve [] para entrada nula o indefinida', () => {
    expect(normSubs(null)).toEqual([]);
    expect(normSubs(undefined)).toEqual([]);
  });
});

// scopeOf sin códigos configurados en el entorno siempre resuelve a null.
describe('scopeOf (sin códigos en el entorno)', () => {
  it('devuelve null para cualquier código cuando no hay CODES', () => {
    expect(scopeOf('')).toBe(null);
    expect(scopeOf(null)).toBe(null);
    expect(scopeOf('cualquier-cosa')).toBe(null);
  });
});
