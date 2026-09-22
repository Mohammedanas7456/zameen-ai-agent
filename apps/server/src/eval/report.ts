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
  turns: TurnReport[];
}

/** One screen of results: a line per case, detail only where something went wrong. */
export function formatReport(reports: CaseReport[]): string {
  const lines: string[] = [];
  for (const c of reports) {
    lines.push(`${c.passed ? '✓' : '✗'} ${c.name} — ${c.why}`);
    c.turns.forEach((t, i) => {
      const noisy = t.verdict.failures.length > 0 || t.verdict.warnings.length > 0;
      if (!noisy) return;
      lines.push(`  turn ${i + 1}: "${t.user}"`);
      for (const f of t.verdict.failures) lines.push(`    FAIL ${f}`);
      for (const w of t.verdict.warnings) lines.push(`    warn ${w}`);
      if (t.verdict.failures.length > 0) {
        lines.push(`    searches: ${JSON.stringify(t.observed.searches)}`);
        lines.push(`    narration: ${t.observed.narration.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    });
  }
  const passed = reports.filter((r) => r.passed).length;
  lines.push('');
  lines.push(`${passed}/${reports.length} cases passed`);
  return lines.join('\n');
}
