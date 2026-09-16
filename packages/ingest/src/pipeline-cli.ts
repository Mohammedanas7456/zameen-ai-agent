/**
 * Operate the ingestion pipeline: trigger a run, watch status, inspect failures.
 *
 *   npm run pipeline:run       -- trigger a run now and follow it
 *   npm run pipeline:status    -- show recent runs
 *   npm run pipeline:failures  -- show dead-lettered records and why they failed
 */
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, VectaraError, type VectaraClient } from './vectara.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnv({ path: join(ROOT, '.env') });

const PIPELINE_KEY = process.env['VECTARA_PIPELINE_KEY'] ?? 'zameen_karachi_daily';

interface Run {
  id: string;
  status: string;
  trigger_type?: string;
  records_fetched?: number;
  records_processed?: number;
  records_skipped?: number;
  records_failed?: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DeadLetter {
  source_record_id?: string;
  status?: string;
  error_message?: string;
}

/** Turn a raw error message into a short, groupable cause. */
function classify(message: string): string {
  const retryable = message.includes('nonRetryable=false') ? ' (retryable)' : '';
  if (message.includes('HTTP 500')) return `Vectara Agent API 500 - transient${retryable}`;
  if (message.includes('Failed to evaluate step transit')) {
    return `step transition could not be evaluated${retryable}`;
  }
  if (message.includes('timeout') || message.includes('Timeout')) return `timeout${retryable}`;
  return `${message.slice(0, 70)}${retryable}`;
}

function describe(run: Run): string {
  const counts = [
    `fetched ${run.records_fetched ?? 0}`,
    `indexed ${run.records_processed ?? 0}`,
    `skipped ${run.records_skipped ?? 0}`,
    `failed ${run.records_failed ?? 0}`,
  ].join('  ');
  return `${run.status.padEnd(10)} ${counts}`;
}

async function listRuns(client: VectaraClient, limit = 5): Promise<Run[]> {
  const { data } = await client.request<{ runs?: Run[] }>(
    'GET',
    `/pipelines/${PIPELINE_KEY}/runs?limit=${limit}`,
  );
  return data.runs ?? [];
}

async function follow(client: VectaraClient, runId: string): Promise<Run | null> {
  // Runs take minutes; poll gently and print only when something changes.
  let last = '';
  let missing = 0;

  for (let i = 0; i < 240; i++) {
    const run = (await listRuns(client, 10)).find((r) => r.id === runId);

    if (!run) {
      // A freshly triggered run takes a moment to appear in the listing, so
      // absence is only conclusive after several consecutive misses.
      if (++missing > 5) {
        console.warn('  run is no longer listed — check "npm run pipeline:status"');
        return null;
      }
      await sleep(5_000);
      continue;
    }
    missing = 0;

    const line = describe(run);
    if (line !== last) {
      console.log(`  ${line}`);
      last = line;
    }
    if (run.status !== 'running' && run.status !== 'pending') return run;
    await sleep(15_000);
  }
  console.warn('  still running after 60 minutes — stopping the watch, the run continues');
  return null;
}

async function main() {
  const client = clientFromEnv();
  const command = process.argv[2] ?? 'status';

  if (command === 'status') {
    const runs = await listRuns(client, 10);
    if (runs.length === 0) {
      console.log(`No runs yet for "${PIPELINE_KEY}". Trigger one with: npm run pipeline:run`);
      return;
    }
    console.log(`Recent runs for "${PIPELINE_KEY}":\n`);
    for (const run of runs) {
      const when = run.started_at ? new Date(run.started_at).toISOString() : '';
      console.log(`  ${when}  ${(run.trigger_type ?? '').padEnd(7)} ${describe(run)}`);
      if (run.error) console.log(`      error: ${run.error.slice(0, 200)}`);
    }
    return;
  }

  if (command === 'run') {
    console.log(`Triggering "${PIPELINE_KEY}" ...`);
    const { data } = await client.request<{ id?: string }>(
      'POST',
      `/pipelines/${PIPELINE_KEY}/trigger`,
      {},
    );
    if (!data.id) throw new Error('Trigger returned no run id');
    console.log(`Run ${data.id}\n`);

    const finished = await follow(client, data.id);
    if (!finished) return;

    const failed = finished.records_failed ?? 0;
    console.log(`\n${finished.status === 'completed' ? 'Done' : finished.status}.`);
    if (failed > 0) {
      console.warn(
        `${failed} record(s) failed. Those pages were read wrong and were deliberately not ` +
          `indexed — inspect a session under the ingest agent to see why.`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'failures') {
    const { data } = await client.request<{ dead_letters?: DeadLetter[] }>(
      'GET',
      `/pipelines/${PIPELINE_KEY}/dead_letters?limit=50`,
    );
    const letters = data.dead_letters ?? [];
    if (letters.length === 0) {
      console.log(`No failed records for "${PIPELINE_KEY}".`);
      return;
    }

    // Group by cause: one transient outage produces many identical entries,
    // and reading them one by one hides that they are all the same thing.
    const groups = new Map<string, { count: number; example: string }>();
    for (const letter of letters) {
      const cause = classify(letter.error_message ?? '');
      const group = groups.get(cause);
      if (group) group.count++;
      else groups.set(cause, { count: 1, example: letter.source_record_id ?? '' });
    }

    console.log(`${letters.length} failed record(s) for "${PIPELINE_KEY}":\n`);
    for (const [cause, { count, example }] of groups) {
      console.log(`  ${String(count).padStart(3)}x  ${cause}`);
      if (example) console.log(`        e.g. ${example.slice(0, 96)}`);
    }
    console.log(
      '\nRecords marked retryable are retried on the next run. A validation ' +
        'failure means the page was read wrong and was deliberately not indexed.',
    );
    return;
  }

  console.error(`Unknown command "${command}". Use "run", "status" or "failures".`);
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
