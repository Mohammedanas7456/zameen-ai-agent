/**
 * Operate the ingestion pipeline: trigger a run, watch status, inspect failures.
 *
 *   npm run pipeline:run      -- trigger a run now and follow it
 *   npm run pipeline:status   -- show recent runs
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

  console.error(`Unknown command "${command}". Use "run" or "status".`);
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
