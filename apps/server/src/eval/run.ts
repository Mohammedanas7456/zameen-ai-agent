/**
 * Replay scripted conversations against the live agent and grade them.
 *
 *   npm run eval                         -- every case
 *   npm run eval -- --case all-in-one    -- one case (repeatable)
 *   npm run eval -- --json eval.json     -- also write the full report
 *
 * This runs the real chat loop in-process, so what it grades is exactly what
 * the server does: the filters each search used, the listings that came back,
 * and the narration. It costs one session and one to four model turns per
 * case, so it runs only when invoked, and one case at a time.
 */
import { writeFile } from 'node:fs/promises';
import type { Listing, SearchFilters } from '@zameen/shared';
import { handleUserMessage } from '../chat.js';
import { LISTINGS_SHOWN_TO_AGENT } from '../criteria.js';
import { getFacets } from '../facets.js';
import { createSession, searchListings } from '../vectara.js';
import { CASES, type EvalCase } from './cases.js';
import { evaluateTurn, type Observed } from './check.js';
import { formatReport, parseArgs, resolveOutputPath, type CaseReport, type TurnReport } from './report.js';

/**
 * `turns` is filled in as the case runs rather than returned at the end, so a
 * case that throws half way through still leaves the turns it did grade where
 * `main` can put them in the report.
 */
async function runCase(c: EvalCase, knownAreas: readonly string[], turns: TurnReport[]): Promise<CaseReport> {
  const sessionKey = await createSession(`eval-${c.name}-${Date.now()}`);
  // What the user has said so far in this case. The agent may repeat a budget
  // or an area from turn one in its reply to turn three, and that is the
  // user's own word, not an invention — grounding is allowed all of it.
  const history: string[] = [];

  for (const turn of c.turns) {
    history.push(turn.user);
    const observed: Observed = {
      userMessage: turn.user,
      allowedText: history.join('\n'),
      searches: [],
      listings: [],
      narration: '',
      errors: [],
    };

    // The loop calls searchListings for the real search *and* for the
    // relaxation probes after an empty one. Only a real search is followed
    // by a `listings` event, so the filters in hand when that event arrives
    // are the ones that search used; probe calls overwrite `pending` and
    // are never promoted.
    let pending: SearchFilters | null = null;

    await handleUserMessage(
      sessionKey,
      turn.user,
      (event) => {
        if (event.type === 'token') observed.narration += event.text;
        else if (event.type === 'listings') {
          // The user's grid gets every match; the agent's prompt gets the
          // first eight. Grading the reply against the rest would fail it for
          // a listing it was never shown.
          observed.listings.push(...(event.listings as Listing[]).slice(0, LISTINGS_SHOWN_TO_AGENT));
          if (pending) observed.searches.push(pending);
        } else if (event.type === 'error') observed.errors.push(event.message);
      },
      () => false,
      {
        searchListings: (filters, query, limit) => {
          pending = filters;
          return searchListings(filters, query, limit);
        },
      },
    );

    turns.push({ user: turn.user, observed, verdict: evaluateTurn(turn.expect, observed, knownAreas) });
  }

  return { name: c.name, why: c.why, passed: turns.every((t) => t.verdict.failures.length === 0), turns };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.cases.length > 0 ? CASES.filter((c) => options.cases.includes(c.name)) : CASES;
  if (selected.length === 0) {
    throw new Error(`No such case. Known: ${CASES.map((c) => c.name).join(', ')}`);
  }

  // Area names come from the live corpus, the same source the sidebar uses,
  // so a mention of an area the pipeline added yesterday still counts.
  const knownAreas = (await getFacets()).areas.map((a) => a.name);

  const reports: CaseReport[] = [];
  try {
    for (const c of selected) {
      process.stdout.write(`running ${c.name}…\n`);
      const turns: TurnReport[] = [];
      try {
        reports.push(await runCase(c, knownAreas, turns));
      } catch (err) {
        // A run costs ten sessions and several minutes of model time. One
        // case dying — an expired session, an upstream 500 — must not throw
        // away the nine that would have told us something.
        reports.push({ name: c.name, why: c.why, passed: false, errored: (err as Error).message, turns });
      }
    }

    console.log(`\n${formatReport(reports)}`);
  } finally {
    if (options.json) {
      // `npm run eval` runs with cwd in apps/server; INIT_CWD is where the
      // person actually typed the command, which is what a relative path here
      // should be read against.
      const jsonPath = resolveOutputPath(options.json, process.env['INIT_CWD'], process.cwd());
      await writeFile(jsonPath, `${JSON.stringify(reports, null, 2)}\n`);
      console.log(`full report written to ${jsonPath}`);
    }
  }
  process.exitCode = reports.every((r) => r.passed) ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 2;
});
