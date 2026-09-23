# Agent Model Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, with the eval harness, how the agent behaves on the platform's candidate models and parameter settings — pass rate, latency, tokens, reasoning spend — so the production model and its output cap are chosen from numbers rather than guesses, and so the same measurement can be repeated for Claude the moment an Anthropic key exists.

**Architecture:** Two small extensions and one live study. The eval runner captures the server's per-turn `turn_usage` log through the existing `log` dependency and reports tokens and wall-clock per case and in total, and records which agent it ran against. The provisioning script grows flags to create a *candidate* agent under its own key with a chosen model, output cap and reasoning effort, reusing the production tool instead of replacing it, so production is never touched by a trial. The study then provisions three candidates, runs the eval against each and against production, and writes the comparison to `docs/eval/`. Changing the production agent is a separate, explicit step.

**Tech Stack:** Node 20, TypeScript 5.7, Vitest 2, Vectara Agents API v2 (`model.name`, `model.parameters`), the eval harness from phase 3.

**Spec:** No spec file. Requirements are the phase 4 description agreed in this session, restated in the Goal.

## Global Constraints

- **Run tests as** `VECTARA_API_KEY=test-key npm test`. Typecheck with `npm run typecheck`, exit 0 with no output.
- **No new runtime dependencies.**
- **Production is not a test subject.** The production agent key is `zameen_property_assistant`. Candidate agents use other keys and must reuse the production `search_properties` tool (`--keep-tool`); the setup script refuses a candidate key without it. Nothing in Tasks 1–3 calls Vectara; only Task 4, run by the controller, does.
- **The eval must stay honest.** No case or checker changes in this plan.
- **Do not change the production agent's model or parameters** except in Task 4's final, explicitly recorded step.
- **Commit messages** follow the repo's style: one imperative line, no prefix; body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Comments** explain *why*, in the voice of the existing files.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/eval/report.ts` | `Usage` aggregation, per-case and total usage lines, `RunReport` shape. |
| `apps/server/src/eval/report.test.ts` | Tests for the aggregation and formatting. |
| `apps/server/src/eval/run.ts` | Injects a quiet `log` that feeds `Usage`; times each case; writes the `RunReport` JSON with the agent key. |
| `packages/ingest/src/setup-args.ts` (new) | **Pure.** `parseSetupArgs`, `modelBlock`. |
| `packages/ingest/src/setup-args.test.ts` (new) | Their tests. |
| `packages/ingest/src/setup-vectara.ts` | Uses the parsed options; `--keep-tool` reuses the production tool. |
| `README.md` | "Comparing models" section. |
| `docs/eval/2026-09-23-model-comparison.md` (new, Task 4) | The measured comparison and recommendation. |

---

### Task 1: The eval reports usage and timing

**Files:**
- Modify: `apps/server/src/eval/report.ts`
- Modify: `apps/server/src/eval/run.ts`
- Test: `apps/server/src/eval/report.test.ts`

**Interfaces:**
- Produces in `report.ts`:
  - `export interface Usage { turns: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number }`
  - `export function emptyUsage(): Usage`
  - `export function addUsage(into: Usage, entry: Record<string, unknown>): boolean` — folds one `turn_usage` log entry in; returns false and changes nothing for any other entry.
  - `CaseReport` gains `usage: Usage` and `durationMs: number`.
  - `export interface RunReport { agentKey: string; startedAt: string; durationMs: number; passed: number; total: number; usage: Usage; cases: CaseReport[] }`
  - `export function summarise(agentKey: string, startedAt: string, durationMs: number, cases: CaseReport[]): RunReport`
  - `formatReport(cases)` prints a usage line under every case and a totals line at the end.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/eval/report.test.ts` (extend the import to include `addUsage`, `emptyUsage`, `summarise`, and the `Usage` type):

```ts
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
```

Update the existing `formatReport` tests: the `report()` fixture must now include `usage: { turns: 1, inputTokens: 3000, cachedTokens: 2560, outputTokens: 100, reasoningTokens: 32 }` and `durationMs: 12_345`, and add:

```ts
  it('prints a usage line under each case and totals at the end', () => {
    const text = formatReport([report({})]);
    expect(text).toContain('    1 turn · 12.3 s · 3,000 in (2,560 cached) · 100 out (32 reasoning)');
    expect(text).toContain('Totals: 1 turn · 12.3 s · 3,000 in (2,560 cached) · 100 out (32 reasoning)');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/report.test.ts`
Expected: FAIL — `addUsage`, `emptyUsage`, `summarise` are not exported; the fixture's new fields are not in `CaseReport`.

- [ ] **Step 3: Implement `report.ts`**

Add after the `CliOptions`/`parseArgs` block:

```ts
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
```

Extend `CaseReport` with two fields (after `turns`):

```ts
  /** Tokens the case spent, summed over its turns, and how long it took. */
  usage: Usage;
  durationMs: number;
```

Add after `CaseReport`:

```ts
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
```

In `formatReport`, after the `if (c.errored) …` line push the usage line for the case:

```ts
    lines.push(`    ${usageLine(c.usage, c.durationMs)}`);
```

and replace the trailing summary with:

```ts
  const passed = reports.filter((r) => r.passed).length;
  const total = summarise('', '', reports.reduce((ms, r) => ms + r.durationMs, 0), reports);
  lines.push('');
  lines.push(`${passed}/${reports.length} cases passed`);
  lines.push(`Totals: ${usageLine(total.usage, total.durationMs)}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/report.test.ts`
Expected: PASS. If `summarise` is called before it is defined, move the helper definitions above `formatReport`.

- [ ] **Step 5: Wire the runner**

In `apps/server/src/eval/run.ts`:

Extend the imports from `./report.js` with `addUsage, emptyUsage, summarise`, and add `import { config } from '../config.js';`.

In `runCase`, before the `for` loop, add:

```ts
  const usage = emptyUsage();
  const startedAt = Date.now();
```

Add a `log` member to the deps object passed to `handleUserMessage` (after `searchListings`):

```ts
        // The server's per-turn token line is the cost of the run; keep it
        // out of the console and in the report. Anything else it logs
        // (an interrupt failure, say) still belongs on the console.
        log: (entry) => {
          if (!addUsage(usage, entry)) console.log(JSON.stringify(entry));
        },
```

Change the `return` to:

```ts
  return {
    name: c.name,
    why: c.why,
    passed: turns.every((t) => t.verdict.failures.length === 0),
    turns,
    usage,
    durationMs: Date.now() - startedAt,
  };
```

In `main`, record `const startedAt = new Date();` before the loop and print the agent key: change `process.stdout.write(\`running ${c.name}…\n\`)` to stay as is, and add before the loop `console.log(\`agent: ${config.agentKey} — ${selected.length} case(s)\`);`. In the `catch` that records an errored case, add `usage: emptyUsage(), durationMs: 0`. In the `finally`, write `summarise(config.agentKey, startedAt.toISOString(), Date.now() - startedAt.getTime(), reports)` instead of `reports`.

- [ ] **Step 6: Typecheck, full suite, dry parse, commit**

Run: `npm run typecheck` — exit 0. Run: `VECTARA_API_KEY=test-key npm test` — all pass. Run: `VECTARA_API_KEY=test-key npm run eval -- --bogus` — prints `unknown argument: --bogus`, exit 2, no network.

```bash
git add apps/server/src/eval/report.ts apps/server/src/eval/report.test.ts apps/server/src/eval/run.ts
git commit -m "Report tokens and time per eval case, and which agent the run talked to" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Candidate agents from the setup script

The setup script hardcodes one agent key and `max_tokens: 1500`, and replaces the search tool on every run — which detaches whichever agent references it. A candidate agent must carry its own key, model and parameters, and reuse the production tool.

**Files:**
- Create: `packages/ingest/src/setup-args.ts`
- Test: `packages/ingest/src/setup-args.test.ts`
- Modify: `packages/ingest/src/setup-vectara.ts`

**Interfaces:**
- `export const PRODUCTION_AGENT_KEY = 'zameen_property_assistant'`
- `export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const`
- `export interface SetupOptions { agentOnly: boolean; skipIndex: boolean; keepTool: boolean; agentKey: string; model: string; maxTokens: number; reasoningEffort: (typeof REASONING_EFFORTS)[number] | null }`
- `export function parseSetupArgs(argv: string[], env: Record<string, string | undefined>): SetupOptions`
- `export function modelBlock(opts: SetupOptions): { name: string; parameters: Record<string, unknown> }`

- [ ] **Step 1: Write the failing tests**

Create `packages/ingest/src/setup-args.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { modelBlock, parseSetupArgs, PRODUCTION_AGENT_KEY } from './setup-args.js';

describe('parseSetupArgs', () => {
  it('defaults to the production agent on gpt-5.5 with a 1500-token cap', () => {
    expect(parseSetupArgs([], {})).toEqual({
      agentOnly: false,
      skipIndex: false,
      keepTool: false,
      agentKey: PRODUCTION_AGENT_KEY,
      model: 'gpt-5.5',
      maxTokens: 1500,
      reasoningEffort: null,
    });
  });

  it('reads the agent key and model from the environment', () => {
    const opts = parseSetupArgs([], { VECTARA_AGENT_KEY: 'k', VECTARA_AGENT_MODEL: 'gpt-5.4' });
    expect(opts.agentKey).toBe('k');
    expect(opts.model).toBe('gpt-5.4');
  });

  it('parses the flags', () => {
    expect(
      parseSetupArgs(['--agent-only', '--keep-tool', '--agent-key', 'zameen_eval_mini', '--model', 'gpt-5-mini', '--max-tokens', '4000', '--reasoning-effort', 'low'], {}),
    ).toEqual({
      agentOnly: true,
      skipIndex: true,
      keepTool: true,
      agentKey: 'zameen_eval_mini',
      model: 'gpt-5-mini',
      maxTokens: 4000,
      reasoningEffort: 'low',
    });
  });

  it('refuses a candidate key that would replace the production tool', () => {
    expect(() => parseSetupArgs(['--agent-key', 'zameen_eval_x'], {})).toThrow(/--keep-tool/);
  });

  it('rejects an unknown reasoning effort, a bad token count and an unknown flag', () => {
    expect(() => parseSetupArgs(['--reasoning-effort', 'max'], {})).toThrow(/reasoning-effort/);
    expect(() => parseSetupArgs(['--max-tokens', 'lots'], {})).toThrow(/max-tokens/);
    expect(() => parseSetupArgs(['--bogus'], {})).toThrow(/unknown argument: --bogus/);
  });
});

describe('modelBlock', () => {
  it('omits reasoning_effort unless asked', () => {
    expect(modelBlock(parseSetupArgs([], {}))).toEqual({ name: 'gpt-5.5', parameters: { max_tokens: 1500 } });
  });

  it('passes reasoning_effort through', () => {
    expect(modelBlock(parseSetupArgs(['--model', 'gpt-5.4', '--max-tokens', '4000', '--reasoning-effort', 'low'], {}))).toEqual({
      name: 'gpt-5.4',
      parameters: { max_tokens: 4000, reasoning_effort: 'low' },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run packages/ingest/src/setup-args.test.ts`
Expected: FAIL with "Failed to resolve import './setup-args.js'".

- [ ] **Step 3: Implement `setup-args.ts`**

```ts
/**
 * Command-line options for the Vectara setup script.
 *
 * Pure, so the rules that keep a model trial away from production can be
 * tested without a network: a candidate agent gets its own key and must
 * reuse the production search tool, because replacing the tool detaches
 * whichever agent references it.
 */

export const PRODUCTION_AGENT_KEY = 'zameen_property_assistant';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface SetupOptions {
  /** Skip the corpus and the index; only the tool and agent. */
  agentOnly: boolean;
  /** Skip re-indexing the 400 documents. */
  skipIndex: boolean;
  /** Reuse the existing search tool instead of replacing it. Required for a candidate key. */
  keepTool: boolean;
  agentKey: string;
  model: string;
  /** Output cap. On the Responses API this includes reasoning tokens. */
  maxTokens: number;
  reasoningEffort: ReasoningEffort | null;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_MAX_TOKENS = 1500;

function isEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function parseSetupArgs(argv: string[], env: Record<string, string | undefined>): SetupOptions {
  const opts: SetupOptions = {
    agentOnly: false,
    skipIndex: false,
    keepTool: false,
    agentKey: env['VECTARA_AGENT_KEY'] ?? PRODUCTION_AGENT_KEY,
    model: env['VECTARA_AGENT_MODEL'] ?? DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEffort: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--agent-only':
        opts.agentOnly = true;
        opts.skipIndex = true;
        break;
      case '--skip-index':
        opts.skipIndex = true;
        break;
      case '--keep-tool':
        opts.keepTool = true;
        break;
      case '--agent-key':
        if (!value) throw new Error('--agent-key needs a value');
        opts.agentKey = value;
        i++;
        break;
      case '--model':
        if (!value) throw new Error('--model needs a value');
        opts.model = value;
        i++;
        break;
      case '--max-tokens': {
        const parsed = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--max-tokens needs a positive integer');
        opts.maxTokens = parsed;
        i++;
        break;
      }
      case '--reasoning-effort':
        if (!value || !isEffort(value)) {
          throw new Error(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}`);
        }
        opts.reasoningEffort = value;
        i++;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }

  if (opts.agentKey !== PRODUCTION_AGENT_KEY && !opts.keepTool) {
    throw new Error(
      `agent key "${opts.agentKey}" is not the production agent; pass --keep-tool so the ` +
        'production search tool is reused rather than replaced out from under it',
    );
  }

  return opts;
}

/** The agent definition's `model` block. */
export function modelBlock(opts: SetupOptions): { name: string; parameters: Record<string, unknown> } {
  const parameters: Record<string, unknown> = { max_tokens: opts.maxTokens };
  if (opts.reasoningEffort) parameters['reasoning_effort'] = opts.reasoningEffort;
  return { name: opts.model, parameters };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run packages/ingest/src/setup-args.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Use it in the setup script**

In `packages/ingest/src/setup-vectara.ts`:

Replace the two lines

```ts
const AGENT_KEY = process.env['VECTARA_AGENT_KEY'] ?? 'zameen_property_assistant';
const AGENT_MODEL = process.env['VECTARA_AGENT_MODEL'] ?? 'gpt-5.5';
```

with

```ts
import { modelBlock, parseSetupArgs, type SetupOptions } from './setup-args.js';

// Parsed at load because agentConfig and ensureSearchTool read it; a bad flag
// must still die with its message rather than a stack trace from an import.
const OPTIONS: SetupOptions = (() => {
  try {
    return parseSetupArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
})();
const AGENT_KEY = OPTIONS.agentKey;
```

(keep the import with the other imports at the top of the file; `process.exit` returns `never`, so the IIFE's type is `SetupOptions`). In `agentConfig`, replace `model: { name: AGENT_MODEL, parameters: { max_tokens: 1500 } },` with `model: modelBlock(OPTIONS),`.

In `ensureSearchTool`, add at the very top of the function body, before the existing `console.log`:

```ts
  if (OPTIONS.keepTool) {
    // A candidate agent shares the production tool. Replacing it here would
    // detach the production agent for the length of the swap.
    console.log(`\n[3/4] Tool "${SEARCH_TOOL_NAME}" (reused)`);
    const existing = await findSearchTools(client);
    const only = existing[0];
    if (existing.length !== 1 || !only) {
      throw new Error(`expected exactly one "${SEARCH_TOOL_NAME}" tool to reuse, found ${existing.length}`);
    }
    console.log(`      ${only.id}`);
    return only.id;
  }
```

In `main`, replace

```ts
  const args = new Set(process.argv.slice(2));
  const agentOnly = args.has('--agent-only');
  const skipIndex = agentOnly || args.has('--skip-index');
```

with

```ts
  const { agentOnly, skipIndex } = OPTIONS;
```

and change the final `console.log` to also print the model: `` console.log(`\nDone.\n  corpus: ${CORPUS_KEY}\n  agent:  ${AGENT_KEY}\n  model:  ${JSON.stringify(modelBlock(OPTIONS))}`); ``.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck` — exit 0. Run: `VECTARA_API_KEY=test-key npm test` — all pass. Do not run any `setup:*` script.

```bash
git add packages/ingest/src/setup-args.ts packages/ingest/src/setup-args.test.ts packages/ingest/src/setup-vectara.ts
git commit -m "Let the setup script provision a candidate agent with its own model and parameters" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

Immediately after the "Evaluating the agent" section (before `## Limits and recovery`), add:

```markdown
## Comparing models

A model trial never touches production. Provision a *candidate* agent under its own key, reusing the production search tool, then point the eval at it:

```bash
npm run setup:agent -- --agent-key zameen_eval_gpt5mini --model gpt-5-mini --max-tokens 4000 --keep-tool
VECTARA_AGENT_KEY=zameen_eval_gpt5mini npm run eval -- --json eval-gpt5mini.json
```

`--reasoning-effort none|minimal|low|medium|high` sets the Responses API's reasoning effort; `--max-tokens` is the output cap, which on that API includes reasoning tokens (production runs 1500). The eval's report ends with a totals line — turns, seconds, input tokens (and how many were cached), output tokens (and how many were reasoning) — and the JSON records `agentKey`, so runs are comparable. Run each candidate at least twice; one run of a stochastic model is one sample.

`GET /v2/llms` on your Vectara account lists the models you can name. To trial Claude, register it once as a customer LLM (`POST /v2/llms` with `type: "anthropic"`, a name, the model id, and your Anthropic key), then pass that name as `--model`. The measured comparison for this repo lives in `docs/eval/`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document how to run a model trial without touching production" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The study

Run by the controller. Spends model turns on the shared account and creates candidate agents there.

- [ ] **Step 1: Baseline.** `npm run eval -- --json docs/eval/runs/2026-09-23-prod-gpt55-1500.json` against production (no env override). Record pass count, seconds, tokens.
- [ ] **Step 2: Provision candidates** with `npm run setup:agent -- --agent-key <key> --model <model> --max-tokens 4000 [--reasoning-effort low] --keep-tool`:
  - `zameen_eval_gpt55_low` — `gpt-5.5`, 4000, `low`. If the platform rejects `reasoning_effort` (HTTP 400 on create, or the first turn errors), record that and re-provision without it as `zameen_eval_gpt55_4k`.
  - `zameen_eval_gpt54` — `gpt-5.4`, 4000.
  - `zameen_eval_gpt5mini` — `gpt-5-mini`, 4000.
  Confirm each with a `GET /v2/agents/<key>` that shows the model block and that `tool_configurations.search_properties.tool_id` equals production's.
- [ ] **Step 3: Run the eval against each candidate**, two candidates at a time in the background, `VECTARA_AGENT_KEY=<key> npm run eval -- --json docs/eval/runs/2026-09-23-<key>.json`. Then a second run of the baseline and of the best-scoring candidate, so the recommendation rests on two samples each.
- [ ] **Step 4: Write `docs/eval/2026-09-23-model-comparison.md`**: a table (agent, model, cap, effort, pass, seconds, input/cached/output/reasoning tokens) per run; a paragraph per candidate on *how* it failed if it failed; a recommendation for production's model and cap; what changed in reply length or style. Commit with the run JSONs.
- [ ] **Step 5: Production.** Raising the output cap is low-risk and reversible: if the baseline model at 4000 scores no worse than at 1500, apply `--max-tokens 4000` to production with `npm run setup:agent -- --max-tokens 4000` (production key, tool replaced as usual — sessions survive) and record the revision in the ledger. A model change is a cost decision: present the numbers and let the user decide; do not switch production's model in this plan.
