import { isAbsolute, join } from 'node:path';
import type { Observed, TurnVerdict } from './check.js';

export interface CliOptions {
  /** Case names to run; empty means all. */
  cases: string[];
  /** Where to write the full JSON report, if anywhere. */
  json: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { cases: [], json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--case' && value) {
      options.cases.push(value);
      i++;
    } else if (arg === '--json' && value) {
      options.json = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  return options;
}

/**
 * `npm run eval` always executes with cwd set to `apps/server` (npm's own
 * workspace-script behaviour), so a relative `--json` path resolved against
 * `process.cwd()` lands somewhere the person who typed the command never
 * meant. `INIT_CWD` — npm's record of where it was invoked from — is what a
 * relative path is actually meant to be read against; a bare `cwd` is kept
 * only as the fallback for when something runs this outside npm.
 */
export function resolveOutputPath(path: string, initCwd: string | undefined, cwd: string): string {
  if (isAbsolute(path)) return path;
  return join(initCwd ?? cwd, path);
}

export interface TurnReport {
  user: string;
  observed: Observed;
  verdict: TurnVerdict;
}

export interface CaseReport {
  name: string;
  why: string;
  passed: boolean;
  /**
   * Why the case never finished — a dead session, an upstream 500. It is not
   * a graded failure but it isn't a pass either, so it gets its own mark: a
   * case that couldn't run tells you nothing about the agent.
   */
  errored?: string;
  turns: TurnReport[];
  /** Tokens the case spent, summed over its turns, and how long it took. */
  usage: Usage;
  durationMs: number;
}

/** Token and turn counts, summed from the server's `turn_usage` log lines. */
export interface Usage {
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): Usage {
  return { turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

/**
 * Vectara reports a token field either as a number or as `{ count, … }`.
 * A bare number is the count and nothing else — it carries no cached or
 * reasoning breakdown, so those sub-keys read as zero.
 */
function count(value: unknown, key = 'count'): number {
  if (typeof value === 'number') return key === 'count' ? value : 0;
  if (value && typeof value === 'object') {
    const n = (value as Record<string, unknown>)[key];
    return typeof n === 'number' ? n : 0;
  }
  return 0;
}

/**
 * Fold one server log entry into `into`. Only `turn_usage` entries carry
 * tokens; anything else is left for the console. Returns whether it counted.
 */
export function addUsage(into: Usage, entry: Record<string, unknown>): boolean {
  if (entry['event'] !== 'turn_usage') return false;
  const usage = entry['usage'];
  if (!usage || typeof usage !== 'object') return false;
  const u = usage as Record<string, unknown>;
  into.turns += 1;
  into.inputTokens += count(u['input_tokens']);
  into.cachedTokens += count(u['input_tokens'], 'cached_tokens');
  into.outputTokens += count(u['output_tokens']);
  into.reasoningTokens += count(u['output_tokens'], 'reasoning_tokens');
  return true;
}

/** Everything one `npm run eval` produced, written as the JSON report. */
export interface RunReport {
  /** The agent the run talked to — the point of a model comparison. */
  agentKey: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  total: number;
  usage: Usage;
  cases: CaseReport[];
}

export function summarise(agentKey: string, startedAt: string, durationMs: number, cases: CaseReport[]): RunReport {
  const usage = emptyUsage();
  for (const c of cases) {
    usage.turns += c.usage.turns;
    usage.inputTokens += c.usage.inputTokens;
    usage.cachedTokens += c.usage.cachedTokens;
    usage.outputTokens += c.usage.outputTokens;
    usage.reasoningTokens += c.usage.reasoningTokens;
  }
  return {
    agentKey,
    startedAt,
    durationMs,
    passed: cases.filter((c) => c.passed).length,
    total: cases.length,
    usage,
    cases,
  };
}

const n = (value: number) => value.toLocaleString('en-US');

function usageLine(usage: Usage, durationMs: number): string {
  const turns = `${usage.turns} turn${usage.turns === 1 ? '' : 's'}`;
  const seconds = `${(durationMs / 1000).toFixed(1)} s`;
  return `${turns} · ${seconds} · ${n(usage.inputTokens)} in (${n(usage.cachedTokens)} cached) · ${n(usage.outputTokens)} out (${n(usage.reasoningTokens)} reasoning)`;
}

/** One screen of results: a line per case, detail only where something went wrong. */
export function formatReport(reports: CaseReport[]): string {
  const lines: string[] = [];
  for (const c of reports) {
    lines.push(`${c.errored ? '!' : c.passed ? '✓' : '✗'} ${c.name} — ${c.why}`);
    if (c.errored) lines.push(`  ERROR ${c.errored}`);
    lines.push(`    ${usageLine(c.usage, c.durationMs)}`);
    c.turns.forEach((t, i) => {
      const noisy = t.verdict.failures.length > 0 || t.verdict.warnings.length > 0;
      if (!noisy) return;
      lines.push(`  turn ${i + 1}: "${t.user}"`);
      for (const f of t.verdict.failures) lines.push(`    FAIL ${f}`);
      for (const w of t.verdict.warnings) lines.push(`    warn ${w}`);
      if (t.verdict.failures.length > 0) {
        lines.push(`    searches: ${JSON.stringify(t.observed.searches)}`);
        // The whole reply, not the first 300 characters: the ungrounded price
        // is as likely to be in the last sentence as the first, and a report
        // that cuts it off sends the reader to the JSON to see what happened.
        lines.push(`    narration: ${t.observed.narration.replace(/\s+/g, ' ')}`);
      }
    });
  }
  const passed = reports.filter((r) => r.passed).length;
  const total = summarise('', '', reports.reduce((ms, r) => ms + r.durationMs, 0), reports);
  lines.push('');
  lines.push(`${passed}/${reports.length} cases passed`);
  lines.push(`Totals: ${usageLine(total.usage, total.durationMs)}`);
  return lines.join('\n');
}
