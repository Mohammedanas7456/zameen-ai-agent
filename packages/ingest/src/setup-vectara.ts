/**
 * Provision everything this app needs in Vectara, idempotently:
 *   1. the corpus (with its filter-attribute schema)
 *   2. the 400 listing documents
 *   3. the `search_properties` lambda tool
 *   4. the agent, wired to that tool
 *
 * Safe to re-run: the corpus is reused if it exists, documents are replaced,
 * and the tool and agent are recreated (the agent is torn down first, since an
 * agent referencing a tool blocks that tool's deletion).
 */
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Facets, Listing } from '@zameen/shared';
import { clientFromEnv, VectaraError, type VectaraClient } from './vectara.js';
import { toDocument, FILTER_ATTRIBUTES } from './document.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Workspace scripts run with their own package as cwd, so point dotenv at the
// repo root explicitly rather than relying on cwd discovery.
loadEnv({ path: join(ROOT, '.env') });

const CORPUS_KEY = process.env['VECTARA_CORPUS_KEY'] ?? 'zameen-karachi-properties';
const AGENT_KEY = process.env['VECTARA_AGENT_KEY'] ?? 'zameen_property_assistant';
const AGENT_MODEL = process.env['VECTARA_AGENT_MODEL'] ?? 'gpt-5.5';
const SEARCH_TOOL_NAME = 'search_properties';

async function readJson<T>(name: string): Promise<T> {
  const file = join(ROOT, 'data', name);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    throw new Error(`Missing ${file}. Run "npm run scrape && npm run normalize" first.`);
  }
}

async function ensureCorpus(client: VectaraClient): Promise<void> {
  console.log(`\n[1/4] Corpus "${CORPUS_KEY}"`);
  const { status } = await client.request(
    'POST',
    '/corpora',
    {
      key: CORPUS_KEY,
      name: 'Zameen Karachi Properties',
      description: 'Live Zameen.com property listings for Karachi — rentals and sales.',
      encoder_name: 'boomerang-2023-q3',
      filter_attributes: FILTER_ATTRIBUTES.map((attr) => ({
        name: attr.name,
        level: 'document',
        description: attr.description,
        indexed: true,
        type: attr.type,
      })),
    },
    { allowStatuses: [409] },
  );
  console.log(status === 409 ? '      already exists — reusing' : '      created');
}

/** Run `worker` over `items` with at most `size` requests in flight. */
async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

async function indexListings(client: VectaraClient, listings: Listing[]): Promise<void> {
  console.log(`\n[2/4] Indexing ${listings.length} listings`);
  let indexed = 0;
  let replaced = 0;
  const failures: string[] = [];

  // Serial indexing of 400 documents (each a POST, and on re-runs a DELETE plus
  // a second POST) takes tens of minutes. A modest pool keeps it to a couple.
  await pool(listings, 8, async (listing) => {
    const doc = toDocument(listing);
    try {
      const { status } = await client.request(
        'POST',
        `/corpora/${CORPUS_KEY}/documents`,
        doc,
        { allowStatuses: [409] },
      );

      if (status === 409) {
        // Already present from a previous run — replace so edits to the
        // rendering or schema actually take effect.
        await client.request('DELETE', `/corpora/${CORPUS_KEY}/documents/${encodeURIComponent(doc.id)}`);
        await client.request('POST', `/corpora/${CORPUS_KEY}/documents`, doc);
        replaced++;
      }
      indexed++;
    } catch (err) {
      const detail = err instanceof VectaraError ? err.body : (err as Error).message;
      failures.push(`${doc.id}: ${detail.slice(0, 160)}`);
    }

    if (indexed % 100 === 0 && indexed > 0) {
      console.log(`      ${indexed}/${listings.length} ...`);
    }
  });

  console.log(`      indexed ${indexed}/${listings.length}${replaced ? ` (${replaced} replaced)` : ''}`);
  if (failures.length) {
    console.error(`      ${failures.length} FAILED:`);
    for (const f of failures.slice(0, 5)) console.error(`        ${f}`);
    throw new Error(`${failures.length} documents failed to index`);
  }
}

function renderAreaList(facets: Facets): string {
  const LEVEL_LABEL: Record<number, string> = { 3: 'district', 4: 'area', 5: 'project' };
  // Only areas with enough listings to be worth offering; the long tail of
  // one-off project names would bloat the prompt without helping.
  return facets.areas
    .filter((a) => a.count >= 2)
    .map((a) => `- ${a.name} (${LEVEL_LABEL[a.level] ?? 'area'}, ${a.count} listings)`)
    .join('\n');
}

interface ToolSummary {
  id: string;
  name?: string;
}

/**
 * Create (or replace) the agent's search tool.
 *
 * It is a lambda because a lambda's input schema is generated from its Python
 * signature and is therefore flat — which is the part a model can actually
 * fill. The built-in corpora_search tool takes a nested `search` object that
 * the model never emits, and whose `corpora` array can only be set through
 * `argument_override`, making a per-call metadata filter impossible.
 *
 * The lambda only validates criteria; the server performs the real search.
 */
async function ensureSearchTool(client: VectaraClient): Promise<string> {
  console.log(`\n[3/4] Tool "${SEARCH_TOOL_NAME}"`);
  const code = await readFile(join(ROOT, 'vectara', 'search_properties.py'), 'utf8');

  // Tools are immutable in the ways that matter here, so replace rather than
  // patch. An agent still referencing the old tool blocks its deletion, which
  // is why the agent is (re)created after this step.
  //
  // The listing must be paged through: the account has several hundred built-in
  // tools, so a single page never reaches our own.
  let pageKey: string | undefined;
  let deleted = 0;
  do {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const { data } = await client.request<{
      tools?: ToolSummary[];
      metadata?: { page_key?: string };
    }>('GET', `/tools?${query}`);

    for (const tool of data.tools ?? []) {
      if (tool.name === SEARCH_TOOL_NAME) {
        await client.request('DELETE', `/tools/${tool.id}`, undefined, {
          allowStatuses: [400, 404, 409],
        });
        deleted++;
      }
    }
    pageKey = data.metadata?.page_key || undefined;
  } while (pageKey);

  if (deleted > 0) console.log(`      removed ${deleted} previous version(s)`);

  const created = await client.request<{ id?: string; function_definition?: { validation_status?: string } }>(
    'POST',
    '/tools',
    {
      type: 'lambda',
      language: 'python',
      name: SEARCH_TOOL_NAME,
      title: 'Search Karachi Properties',
      description:
        'Search Karachi property listings by structured criteria (purpose, area, bedrooms, ' +
        'price, property type, floor). Returns the normalised criteria; the matching listings ' +
        'are delivered in the following message.',
      code,
    },
  );

  const id = created.data.id;
  if (!id) throw new Error('Tool creation returned no id');
  console.log(`      created ${id} (${created.data.function_definition?.validation_status ?? 'unknown'})`);
  return id;
}

async function ensureAgent(
  client: VectaraClient,
  listings: Listing[],
  facets: Facets,
  searchToolId: string,
): Promise<void> {
  console.log(`\n[4/4] Agent "${AGENT_KEY}"`);

  const template = await readFile(join(ROOT, 'vectara', 'agent-instructions.md'), 'utf8');
  const instructions = template
    .replace('{{TOTAL}}', String(listings.length))
    .replace('{{RENT_COUNT}}', String(listings.filter((l) => l.purpose === 'rent').length))
    .replace('{{BUY_COUNT}}', String(listings.filter((l) => l.purpose === 'buy').length))
    .replaceAll('{{CORPUS_KEY}}', CORPUS_KEY)
    .replace('{{AREAS}}', renderAreaList(facets));

  const config = {
    key: AGENT_KEY,
    name: 'Zameen Property Assistant',
    description: 'Conversational property search over Zameen.com Karachi listings.',
    model: { name: AGENT_MODEL, parameters: { max_tokens: 1500 } },
    first_step_name: 'main',
    steps: {
      main: {
        type: 'conversational',
        instructions: [
          {
            type: 'inline',
            name: 'zameen_property_assistant',
            template: instructions,
            // The instructions contain `$` and `#` characters that Velocity
            // would try to interpret; plain text avoids that entirely.
            template_type: 'text',
          },
        ],
        output_parser: { type: 'default' },
      },
    },
    tool_configurations: {
      [SEARCH_TOOL_NAME]: {
        type: 'lambda',
        tool_id: searchToolId,
      },
    },
  };

  const created = await client.request('POST', '/agents', config, { allowStatuses: [409] });
  if (created.status === 409) {
    await client.request('PUT', `/agents/${AGENT_KEY}`, config);
    console.log('      already existed — updated in place');
  } else {
    console.log('      created');
  }
}

async function main() {
  // Re-indexing 400 documents is slow and usually unnecessary when only the
  // prompt changed, so allow the steps to be run independently.
  const args = new Set(process.argv.slice(2));
  const agentOnly = args.has('--agent-only');
  const skipIndex = agentOnly || args.has('--skip-index');

  const client = clientFromEnv();
  const listings = await readJson<Listing[]>('listings.json');
  const facets = await readJson<Facets>('facets.json');

  if (!agentOnly) await ensureCorpus(client);
  if (skipIndex) console.log('\n[2/4] Indexing skipped (--skip-index)');
  else await indexListings(client, listings);
  // The agent must be deleted before its tool can be replaced, then recreated
  // pointing at the new tool id.
  await client.request('DELETE', `/agents/${AGENT_KEY}`, undefined, { allowStatuses: [404] });
  const searchToolId = await ensureSearchTool(client);
  await ensureAgent(client, listings, facets, searchToolId);

  console.log(`\nDone.\n  corpus: ${CORPUS_KEY}\n  agent:  ${AGENT_KEY}`);
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
