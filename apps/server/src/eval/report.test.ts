import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { formatReport, parseArgs, resolveOutputPath, type CaseReport } from './report.js';

describe('parseArgs', () => {
  it('defaults to every case and no JSON file', () => {
    expect(parseArgs([])).toEqual({ cases: [], json: null });
  });

  it('collects repeated --case flags and a --json path', () => {
    expect(parseArgs(['--case', 'a', '--json', 'out.json', '--case', 'b'])).toEqual({
      cases: ['a', 'b'],
      json: 'out.json',
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument: --bogus/);
  });
});

describe('resolveOutputPath', () => {
  it('leaves an absolute path unchanged', () => {
    expect(resolveOutputPath('/tmp/eval.json', '/repo', '/repo/apps/server')).toBe('/tmp/eval.json');
  });

  it('joins a relative path to initCwd — where `npm run` was invoked — when it is set', () => {
    expect(resolveOutputPath('eval.json', '/repo', '/repo/apps/server')).toBe(join('/repo', 'eval.json'));
  });

  it('joins a relative path to cwd when there is no initCwd', () => {
    expect(resolveOutputPath('eval.json', undefined, '/repo/apps/server')).toBe(join('/repo/apps/server', 'eval.json'));
  });
});

describe('formatReport', () => {
  const report = (over: Partial<CaseReport>): CaseReport => ({
    name: 'all-in-one',
    why: 'why',
    passed: true,
    turns: [
      {
        user: 'rent a flat',
        observed: { userMessage: 'rent a flat', searches: [{ purpose: 'rent' }], listings: [], narration: 'ok', errors: [] },
        verdict: { failures: [], warnings: [] },
      },
    ],
    ...over,
  });

  it('marks a passing case with a tick and counts the summary', () => {
    const text = formatReport([report({})]);
    expect(text).toContain('✓ all-in-one');
    expect(text).toContain('1/1 cases passed');
  });

  it('lists each failure and warning under the turn that produced it', () => {
    const text = formatReport([
      report({
        passed: false,
        turns: [
          {
            user: 'rent a flat in Clifton',
            observed: { userMessage: 'rent a flat in Clifton', searches: [], listings: [], narration: 'Which area?', errors: [] },
            verdict: { failures: ['expected 1 search(es), got 0'], warnings: ['search 1: extra floor: ground'] },
          },
        ],
      }),
    ]);
    expect(text).toContain('✗ all-in-one');
    expect(text).toContain('turn 1: "rent a flat in Clifton"');
    expect(text).toContain('  FAIL expected 1 search(es), got 0');
    expect(text).toContain('  warn search 1: extra floor: ground');
    expect(text).toContain('0/1 cases passed');
  });
});
