/**
 * Provision the daily Vectara ingestion pipeline, idempotently:
 *   1. the `validate_listing` lambda tool
 *   2. the `zameen_ingest_agent` transform agent
 *   3. the `zameen_karachi_daily` web pipeline (cron trigger, incremental sync)
 *
 * Unlike the backfill in `setup-vectara.ts`, nothing here scrapes: Vectara's
 * crawler fetches the pages, hands each one to the transform agent, and the
 * agent indexes it. Run `npm run setup:pipeline` after the corpus exists.
 */
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, VectaraError, type VectaraClient } from './vectara.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnv({ path: join(ROOT, '.env') });

const CORPUS_KEY = process.env['VECTARA_CORPUS_KEY'] ?? 'zameen-karachi-properties';
const PIPELINE_KEY = process.env['VECTARA_PIPELINE_KEY'] ?? 'zameen_karachi_daily';
const INGEST_AGENT_KEY = process.env['VECTARA_INGEST_AGENT_KEY'] ?? 'zameen_ingest_agent';
const AGENT_MODEL = process.env['VECTARA_AGENT_MODEL'] ?? 'gpt-5.5';
const VALIDATE_TOOL_NAME = 'validate_listing';
const VALIDATE_TOOL_TITLE = 'Validate Zameen Listing';

/** 08:00 Pakistan Standard Time, expressed in UTC (PKT is UTC+5). */
const CRON_EXPRESSION = process.env['VECTARA_PIPELINE_CRON'] ?? '0 3 * * *';

/** Cap per run: roughly today's footprint, so cost stays predictable. */
const MAX_PAGES = Number.parseInt(process.env['VECTARA_PIPELINE_MAX_PAGES'] ?? '400', 10);

/**
 * `artifact_read` and `document_conversion` are first-class tool *types* and
 * must not carry a `tool_id`; these are `dynamic_vectara` and must.
 */
const DYNAMIC_TOOLS = {
  get_document: 'tol_vectara_get_document_20260703',
  core_document_create: 'tol_vectara_core_document_create_20260513',
  finalize_core_documents: 'tol_vectara_finalize_core_documents_20260727',
  core_document_index: 'tol_vectara_core_document_index_20260721',
  current_time: 'tol_vectara_current_time',
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolSummary {
  id: string;
  name?: string;
  title?: string;
}

/**
 * Crawl seeds: the paginated Karachi rent and sale indexes.
 *
 * robots.txt permits `/Rentals/` and `/Homes/` but disallows the `/Karachi*`
 * relative-link paths, so only these canonical index URLs are used as seeds.
 * `max_depth: 1` follows their links to the individual property pages.
 */
function seedUrls(): string[] {
  const urls: string[] = [];
  for (const path of ['Rentals', 'Homes']) {
    for (let page = 1; page <= 8; page++) {
      urls.push(`https://www.zameen.com/${path}/Karachi-2-${page}.html`);
    }
  }
  return urls;
}

/** Every tool matching our name or title, paged through the full list. */
async function findValidateTools(client: VectaraClient): Promise<ToolSummary[]> {
  let pageKey: string | undefined;
  const found: ToolSummary[] = [];
  do {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const { data } = await client.request<{
      tools?: ToolSummary[];
      metadata?: { page_key?: string };
    }>('GET', `/tools?${query}`);

    for (const tool of data.tools ?? []) {
      if (tool.name === VALIDATE_TOOL_NAME || tool.title === VALIDATE_TOOL_TITLE) found.push(tool);
    }
    pageKey = data.metadata?.page_key || undefined;
  } while (pageKey);
  return found;
}

/** Build the transform agent's configuration. */
async function agentConfig(validateToolId: string | null): Promise<Record<string, unknown>> {
  const template = await readFile(join(ROOT, 'vectara', 'ingest-agent-instructions.md'), 'utf8');

  return {
    key: INGEST_AGENT_KEY,
    name: 'Zameen Ingest Transform',
    description: 'Pipeline transform: turns one crawled Zameen page into one indexed document.',
    // No temperature: gpt-5.5 rejects the parameter outright.
    model: { name: AGENT_MODEL, parameters: { max_tokens: 2000 } },
    first_step_name: 'main',
    steps: {
      main: {
        type: 'conversational',
        instructions: [
          {
            type: 'inline',
            name: 'zameen_ingest',
            template: template.replaceAll('{{CORPUS_KEY}}', CORPUS_KEY),
            template_type: 'text',
          },
        ],
        output_parser: { type: 'default' },
      },
    },
    tool_configurations: {
      ...(validateToolId
        ? { [VALIDATE_TOOL_NAME]: { type: 'lambda', tool_id: validateToolId } }
        : {}),
      // Raw crawled HTML runs to hundreds of KB, far too much to pull into a
      // model turn, so the page is converted to markdown and only that is read.
      document_conversion: { type: 'document_conversion' },
      artifact_read: { type: 'artifact_read' },
      current_time: { type: 'dynamic_vectara', tool_id: DYNAMIC_TOOLS.current_time },
      // Lets the agent skip a listing already in the corpus, which keeps runs
      // additive and cheap: only genuinely new listings cost an extraction.
      get_document: { type: 'dynamic_vectara', tool_id: DYNAMIC_TOOLS.get_document },
      core_document_create: { type: 'dynamic_vectara', tool_id: DYNAMIC_TOOLS.core_document_create },
      finalize_core_documents: {
        type: 'dynamic_vectara',
        tool_id: DYNAMIC_TOOLS.finalize_core_documents,
      },
      core_document_index: { type: 'dynamic_vectara', tool_id: DYNAMIC_TOOLS.core_document_index },
    },
  };
}

/** Create the agent, or replace it wholesale if it already exists. */
async function putAgent(client: VectaraClient, validateToolId: string | null): Promise<void> {
  const config = await agentConfig(validateToolId);
  const created = await client.request('POST', '/agents', config, { allowStatuses: [409] });
  if (created.status === 409) {
    // PUT replaces; PATCH merges, which cannot remove a tool reference.
    await client.request('PUT', `/agents/${INGEST_AGENT_KEY}`, config);
  }
}

/**
 * Replace the validation lambda.
 *
 * Vectara refuses to delete a tool that an agent references, and enforces
 * unique tool titles — so the agent is first replaced *without* the lambda,
 * freeing the old tool for deletion, and reattached afterwards. Deletion is
 * asynchronous, hence the wait before recreating under the same title.
 */
async function ensureValidateTool(client: VectaraClient): Promise<string> {
  console.log(`\n[1/3] Tool "${VALIDATE_TOOL_NAME}"`);

  const existing = await findValidateTools(client);
  if (existing.length > 0) {
    await putAgent(client, null);
    console.log('      detached from the ingest agent');

    for (const tool of existing) {
      await client.request('DELETE', `/tools/${tool.id}`, undefined, { allowStatuses: [404] });
    }

    let remaining = existing.length;
    for (let i = 0; i < 20 && remaining > 0; i++) {
      await sleep(1500);
      remaining = (await findValidateTools(client)).length;
    }
    if (remaining > 0) {
      throw new Error(
        `${remaining} old "${VALIDATE_TOOL_NAME}" tool(s) could not be deleted — ` +
          'another agent or pipeline still references them.',
      );
    }
    console.log(`      removed ${existing.length} previous version(s)`);
  }

  const code = await readFile(join(ROOT, 'vectara', 'validate_listing.py'), 'utf8');
  const { data } = await client.request<{
    id?: string;
    function_definition?: { validation_status?: string };
  }>('POST', '/tools', {
    type: 'lambda',
    language: 'python',
    name: VALIDATE_TOOL_NAME,
    title: VALIDATE_TOOL_TITLE,
    description:
      'Validate and normalise one extracted Zameen listing. Range-checks prices, bedrooms ' +
      'and area, constrains enums, derives the lowercase twins and price label, and returns ' +
      'success:false when a value is implausible. Call this before indexing.',
    code,
  });

  if (!data.id) throw new Error('Tool creation returned no id');
  console.log(`      created ${data.id} (${data.function_definition?.validation_status ?? '?'})`);
  return data.id;
}

async function ensureIngestAgent(client: VectaraClient, validateToolId: string): Promise<void> {
  console.log(`\n[2/3] Agent "${INGEST_AGENT_KEY}"`);
  await putAgent(client, validateToolId);
  console.log('      configured');
}

async function ensurePipeline(client: VectaraClient): Promise<void> {
  console.log(`\n[3/3] Pipeline "${PIPELINE_KEY}"`);

  const config = {
    key: PIPELINE_KEY,
    name: 'Zameen Karachi Daily',
    description: 'Daily incremental crawl of Karachi rent and sale listings from Zameen.com.',
    source: {
      type: 'web',
      pages_source: {
        type: 'crawl',
        urls: seedUrls(),
        // One hop: index page -> property page.
        max_depth: 1,
        same_domain_only: true,
        // No pos_regex: it gates which pages are *expanded for links*, not
        // merely which are kept. Set to '/Property/' it stopped the /Rentals/
        // and /Homes/ seeds from ever being expanded, so the crawl never left
        // depth 0.
        //
        // That leaves neg_regex to keep the budget on listings. These patterns
        // are deliberately written without trailing slashes: the real nav links
        // are '/tools' and '/plots.html', so '/tools/' matches none of them.
        neg_regex: [
          '/agencies',
          '/agents',
          '/new-projects',
          '/ur/',
          '/blog',
          '/forum',
          '/news',
          '/tools',
          '/trends',
          '/area-guides',
          '/society_maps',
          '/plots',
          '/commercial',
          '/index',
          '/contactus',
          '/aboutus',
          '/careers',
          '/rentals\\.html',
          '/homes\\.html',
          // Subdomains: same_domain_only treats these as the same registered
          // domain, so they have to be excluded by pattern.
          'profolio\\.zameen\\.com',
          'expo\\.zameen\\.com',
        ],
      },
      max_pages: MAX_PAGES,
      // Deliberately gentler than the 2.0 default; robots.txt is honoured too.
      requests_per_second: 1.0,
      max_concurrent_fetches: 2,
      respect_robots_txt: true,
      // The listing data is server-rendered, so a headless browser buys nothing.
      js_rendering: false,
    },
    trigger: { type: 'cron', expression: CRON_EXPRESSION },
    transform: {
      type: 'agent',
      agent_key: INGEST_AGENT_KEY,
      // No `verification` condition. The agent's output is not a plain string
      // at `$.output`, so a text test there marks every record failed — and a
      // failed record's links are never expanded, which stopped the crawl dead
      // at the 16 seeds. Correctness is enforced by `validate_listing`, which
      // the agent must pass before it is allowed to index anything.
    },
    sync_mode: 'incremental',
    enabled: true,
  };

  // A duplicate key comes back as 400 here, not the 409 other endpoints use.
  const created = await client.request('POST', '/pipelines', config, {
    allowStatuses: [400, 409],
  });
  if (created.status !== 201) {
    await client.request('PUT', `/pipelines/${PIPELINE_KEY}`, config);
    console.log('      already existed — updated in place');
  } else {
    console.log('      created');
  }

  console.log(`      trigger:   cron "${CRON_EXPRESSION}" (UTC)`);
  console.log('      sync_mode: incremental');
  console.log(`      seeds:     ${seedUrls().length} index pages, max_pages ${MAX_PAGES}`);
}

async function main() {
  const client = clientFromEnv();

  // Fail early rather than creating a pipeline that indexes into nothing.
  await client.request('GET', `/corpora/${CORPUS_KEY}`).catch(() => {
    throw new Error(`Corpus "${CORPUS_KEY}" not found. Run "npm run setup:vectara" first.`);
  });

  const validateToolId = await ensureValidateTool(client);
  await ensureIngestAgent(client, validateToolId);
  await ensurePipeline(client);

  console.log('\nDone.');
  console.log('  Trigger a run now:  npm run pipeline:run');
  console.log('  Watch runs:         npm run pipeline:status');
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
