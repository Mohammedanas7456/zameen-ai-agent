import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  addUsage,
  emptyUsage,
  formatReport,
  parseArgs,
  resolveOutputPath,
  summarise,
  type CaseReport,
  type Usage,
} from './report.js';

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
        observed: {
          userMessage: 'rent a flat',
          allowedText: 'rent a flat',
          searches: [{ purpose: 'rent' }],
          listings: [],
          narration: 'ok',
          errors: [],
        },
        verdict: { failures: [], warnings: [] },
      },
    ],
    usage: { turns: 1, inputTokens: 3000, cachedTokens: 2560, outputTokens: 100, reasoningTokens: 32 },
    durationMs: 12_345,
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
            observed: {
              userMessage: 'rent a flat in Clifton',
              allowedText: 'rent a flat in Clifton',
              searches: [],
              listings: [],
              narration: 'Which area?',
              errors: [],
            },
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

  it('marks a case that threw, and says what it threw', () => {
    const text = formatReport([report({ passed: false, errored: 'Vectara session expired', turns: [] })]);
    expect(text).toContain('! all-in-one');
    expect(text).toContain('ERROR Vectara session expired');
    expect(text).toContain('0/1 cases passed');
  });

  it('prints the whole narration of a failing turn, not the first screenful', () => {
    const narration = `${'The Clifton flat is 1.25 lakh. '.repeat(12)}And the last one is at 1.9 lakh.`;
    expect(narration.length).toBeGreaterThan(300);
    const text = formatReport([
      report({
        passed: false,
        turns: [
          {
            user: 'rent a flat in Clifton',
            observed: {
              userMessage: 'rent a flat in Clifton',
              allowedText: 'rent a flat in Clifton',
              searches: [{ purpose: 'rent' }],
              listings: [],
              narration,
              errors: [],
            },
            verdict: { failures: ['price not in results: PKR 190,000'], warnings: [] },
          },
        ],
      }),
    ]);
    expect(text).toContain('And the last one is at 1.9 lakh.');
  });

  it('prints a usage line under each case and totals at the end', () => {
    const text = formatReport([report({})]);
    expect(text).toContain('    1 turn · 12.3 s · 3,000 in (2,560 cached) · 100 out (32 reasoning)');
    expect(text).toContain('Totals: 1 turn · 12.3 s · 3,000 in (2,560 cached) · 100 out (32 reasoning)');
  });
});

describe('addUsage', () => {
  const entry = (usage: unknown) => ({ event: 'turn_usage', sessionKey: 's', usage });

  it('folds in the object-shaped counts Vectara sends', () => {
    const u = emptyUsage();
    expect(
      addUsage(u, entry({ input_tokens: { count: 3000, cached_tokens: 2560 }, output_tokens: { count: 100, reasoning_tokens: 32 }, total_tokens: 3100 })),
    ).toBe(true);
    expect(u).toEqual({ turns: 1, inputTokens: 3000, cachedTokens: 2560, outputTokens: 100, reasoningTokens: 32 });
  });

  it('accepts plain numbers for the token fields', () => {
    const u = emptyUsage();
    addUsage(u, entry({ input_tokens: 10, output_tokens: 5 }));
    expect(u).toEqual({ turns: 1, inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0 });
  });

  it('accumulates across turns', () => {
    const u = emptyUsage();
    addUsage(u, entry({ input_tokens: { count: 10 }, output_tokens: { count: 1 } }));
    addUsage(u, entry({ input_tokens: { count: 20 }, output_tokens: { count: 2, reasoning_tokens: 1 } }));
    expect(u).toEqual({ turns: 2, inputTokens: 30, cachedTokens: 0, outputTokens: 3, reasoningTokens: 1 });
  });

  it('ignores any other log entry', () => {
    const u = emptyUsage();
    expect(addUsage(u, { event: 'interrupt_failed', sessionKey: 's', error: 'x' })).toBe(false);
    expect(u).toEqual(emptyUsage());
  });
});

describe('summarise', () => {
  it('totals passes, duration and usage across cases', () => {
    const usageA: Usage = { turns: 2, inputTokens: 100, cachedTokens: 50, outputTokens: 10, reasoningTokens: 2 };
    const usageB: Usage = { turns: 1, inputTokens: 40, cachedTokens: 0, outputTokens: 4, reasoningTokens: 0 };
    const base = { why: 'w', turns: [] };
    const run = summarise('agent_x', '2026-09-23T10:00:00.000Z', 1234, [
      { ...base, name: 'a', passed: true, usage: usageA, durationMs: 1000 },
      { ...base, name: 'b', passed: false, usage: usageB, durationMs: 234 },
    ]);
    expect(run).toMatchObject({
      agentKey: 'agent_x',
      passed: 1,
      total: 2,
      durationMs: 1234,
      usage: { turns: 3, inputTokens: 140, cachedTokens: 50, outputTokens: 14, reasoningTokens: 2 },
    });
    expect(run.cases).toHaveLength(2);
  });
});
