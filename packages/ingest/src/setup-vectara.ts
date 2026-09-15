/**
 * Provision everything this app needs in Vectara, idempotently:
 *   1. the corpus (with its filter-attribute schema)
 *   2. the 400 listing documents
 *   3. the agent, wired to a corpus-search tool pinned to that corpus
 *
 * Safe to re-run: the corpus is reused if it exists, documents are replaced,
 * and the agent is updated in place.
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
const SEARCH_TOOL_ID = 'tol_vectara_corpora_search_20260608';
const AGENT_MODEL = process.env['VECTARA_AGENT_MODEL'] ?? 'gpt-5.5';

async function readJson<T>(name: string): Promise<T> {
  const file = join(ROOT, 'data', name);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    throw new Error(`Missing ${file}. Run "npm run scrape && npm run normalize" first.`);
  }
}

async function ensureCorpus(client: VectaraClient): Promise<void> {
  console.log(`\n[1/3] Corpus "${CORPUS_KEY}"`);
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
  console.log(`\n[2/3] Indexing ${listings.length} listings`);
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

async function ensureAgent(client: VectaraClient, listings: Listing[], facets: Facets): Promise<void> {
  console.log(`\n[3/3] Agent "${AGENT_KEY}"`);

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
      // No `search` override: overriding it satisfies the schema's required
      // property, so the model stops emitting one and the metadata_filter is
      // never applied. The corpus key is pinned in the instructions instead.
      search_properties: {
        type: 'dynamic_vectara',
        tool_id: SEARCH_TOOL_ID,
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
  if (skipIndex) console.log('\n[2/3] Indexing skipped (--skip-index)');
  else await indexListings(client, listings);
  await ensureAgent(client, listings, facets);

  console.log(`\nDone.\n  corpus: ${CORPUS_KEY}\n  agent:  ${AGENT_KEY}`);
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
