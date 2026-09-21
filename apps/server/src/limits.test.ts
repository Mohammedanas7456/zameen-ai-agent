import { describe, it, expect } from 'vitest';
import { SessionGate } from './limits.js';

describe('SessionGate', () => {
  it('admits a session, holds it while in flight, and admits again after release', () => {
    const gate = new SessionGate({ maxTurns: 10 });
    expect(gate.admit('s1')).toBe('ok');
    expect(gate.admit('s1')).toBe('busy');
    gate.release('s1');
    expect(gate.admit('s1')).toBe('ok');
  });

  it('keeps sessions independent', () => {
    const gate = new SessionGate({ maxTurns: 10 });
    expect(gate.admit('s1')).toBe('ok');
    expect(gate.admit('s2')).toBe('ok');
  });

  it('refuses a session that has used its turn budget', () => {
    const gate = new SessionGate({ maxTurns: 2 });
    expect(gate.admit('s1')).toBe('ok');
    gate.release('s1');
    expect(gate.admit('s1')).toBe('ok');
    gate.release('s1');
    expect(gate.admit('s1')).toBe('exhausted');
  });

  it('does not count a refused admission as a turn', () => {
    const gate = new SessionGate({ maxTurns: 2 });
    gate.admit('s1');
    expect(gate.admit('s1')).toBe('busy');
    gate.release('s1');
    expect(gate.admit('s1')).toBe('ok');
    gate.release('s1');
    expect(gate.admit('s1')).toBe('exhausted');
  });

  it('forgets the oldest session once it tracks more than maxTracked', () => {
    const gate = new SessionGate({ maxTurns: 1, maxTracked: 2 });
    gate.admit('a');
    gate.release('a');
    gate.admit('b');
    gate.release('b');
    gate.admit('c'); // evicts 'a'
    gate.release('c');
    // 'c' is still tracked and has spent its one turn; 'a' was forgotten, so
    // its budget is back (and admitting it evicts 'b' in turn).
    expect(gate.admit('c')).toBe('exhausted');
    expect(gate.admit('a')).toBe('ok');
  });

  it('releasing an unknown session is harmless', () => {
    const gate = new SessionGate({ maxTurns: 1 });
    expect(() => gate.release('nope')).not.toThrow();
  });
});
