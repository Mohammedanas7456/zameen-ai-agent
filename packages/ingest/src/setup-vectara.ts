/**
 * Provision everything this app needs in Vectara, idempotently:
 *   1. the corpus (with its filter-attribute schema)
 *   2. the 400 listing documents
 *   3. the `search_properties` lambda tool
 *   4. the agent, wired to that tool
 *
 * Safe to re-run: the corpus is reused if it exists, documents are replaced,
 * the tool is replaced, and the agent is updated in place (detached from the
 * old tool first, since an agent referencing a tool blocks its deletion) so
 * its sessions survive.
 */
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Facets, Listing } from '@zameen/shared';
import { clientFromEnv, VectaraError, type VectaraClient } from './vectara.js';
import { toDocument, FILTER_ATTRIBUTES } from './document.js';
import {
  agentName,
  agentsReferencingTool,
  agentsWithoutToolInfo,
  modelBlock,
  parseSetupArgs,
  type AgentToolRefs,
  type SetupOptions,
} from './setup-args.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Workspace scripts run with their own package as cwd, so point dotenv at the
// repo root explicitly rather than relying on cwd discovery.
loadEnv({ path: join(ROOT, '.env') });

const CORPUS_KEY = process.env['VECTARA_CORPUS_KEY'] ?? 'zameen-karachi-properties';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-injected on every input — including the SEARCH RESULTS messages the
 * server sends — so the rule survives long sessions where the system prompt
 * has scrolled out of the model's effective attention.
 */
const RESULTS_REMINDER =
  'Reminder: only describe listings that appear in a SEARCH RESULTS message. Never invent ' +
  'a property, price, area or phone number. If nothing matched, say so and suggest one ' +
  'relaxation rather than inventing a match.';

/** Every tool with our name, paged through the full list: the account has
 *  several hundred built-in tools, so a single page never reaches our own. */
async function findSearchTools(client: VectaraClient): Promise<ToolSummary[]> {
  let pageKey: string | undefined;
  const found: ToolSummary[] = [];
  do {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const { data } = await client.request<{
      tools?: ToolSummary[];
      metadata?: { page_key?: string };
    }>('GET', `/tools?${query}`);

    for (const tool of data.tools ?? []) {
      if (tool.name === SEARCH_TOOL_NAME) found.push(tool);
    }
    pageKey = data.metadata?.page_key || undefined;
  } while (pageKey);
  return found;
}

/** Every agent in the account, paged like the tool list. */
async function listAgents(client: VectaraClient): Promise<AgentToolRefs[]> {
  let pageKey: string | undefined;
  const found: AgentToolRefs[] = [];
  do {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const { data } = await client.request<{
      agents?: AgentToolRefs[];
      metadata?: { page_key?: string };
    }>('GET', `/agents?${query}`);

    found.push(...(data.agents ?? []));
    pageKey = data.metadata?.page_key || undefined;
  } while (pageKey);
  return found;
}

/**
 * The agent's full definition. With `searchToolId` null it is built without
 * the search tool, which is how the tool is freed for replacement.
 */
async function agentConfig(
  listings: Listing[],
  facets: Facets,
  searchToolId: string | null,
): Promise<Record<string, unknown>> {
  const template = await readFile(join(ROOT, 'vectara', 'agent-instructions.md'), 'utf8');
  const instructions = template
    .replace('{{TOTAL}}', String(listings.length))
    .replace('{{RENT_COUNT}}', String(listings.filter((l) => l.purpose === 'rent').length))
    .replace('{{BUY_COUNT}}', String(listings.filter((l) => l.purpose === 'buy').length))
    .replaceAll('{{CORPUS_KEY}}', CORPUS_KEY)
    .replace('{{AREAS}}', renderAreaList(facets));

  return {
    key: AGENT_KEY,
    name: agentName(OPTIONS),
    description: 'Conversational property search over Zameen.com Karachi listings.',
    model: modelBlock(OPTIONS),
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
        reminders: [
          {
            type: 'templated',
            template_type: 'text',
            template: RESULTS_REMINDER,
            hooks: ['input_message'],
          },
        ],
        output_parser: { type: 'default' },
      },
    },
    tool_configurations: searchToolId
      ? { [SEARCH_TOOL_NAME]: { type: 'lambda', tool_id: searchToolId } }
      : {},
  };
}

/**
 * Create the agent, or replace it in place. PUT keeps the agent's sessions;
 * the delete-and-recreate this used to do ended every live conversation on
 * each prompt change. Returns true when the agent was newly created.
 */
async function putAgent(client: VectaraClient, config: Record<string, unknown>): Promise<boolean> {
  const created = await client.request('POST', '/agents', config, { allowStatuses: [409] });
  if (created.status !== 409) return true;
  // PUT replaces; PATCH merges, which cannot remove a tool reference.
  await client.request('PUT', `/agents/${AGENT_KEY}`, config);
  return false;
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
 *
 * Vectara refuses to delete a tool an agent references, so the agent is first
 * replaced *without* the tool, and reattached in `ensureAgent`. Deletion is
 * asynchronous, hence the wait before recreating under the same name.
 */
async function ensureSearchTool(client: VectaraClient, listings: Listing[], facets: Facets): Promise<string> {
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

  console.log(`\n[3/4] Tool "${SEARCH_TOOL_NAME}"`);

  const existing = await findSearchTools(client);

  // Vectara refuses to delete a tool another agent references, so with a
  // model-trial candidate sharing this one the detach below would strand
  // production without a tool. Check before touching anything.
  if (existing.length > 0) {
    const agents = await listAgents(client);
    const unknown = agentsWithoutToolInfo(agents, AGENT_KEY);
    if (unknown.length > 0) {
      throw new Error(
        `cannot tell whether ${unknown.join(', ')} still use the search tool (the agent listing ` +
          'carried no tool configurations for them) — re-run with --keep-tool to reuse it unchanged',
      );
    }
    for (const tool of existing) {
      const others = agentsReferencingTool(agents, tool.id, AGENT_KEY);
      if (others.length > 0) {
        throw new Error(
          `tool ${tool.id} is also used by ${others.join(', ')} — re-run with --keep-tool to reuse it, ` +
            'or delete those agents first',
        );
      }
    }
  }

  if (existing.length > 0) {
    await putAgent(client, await agentConfig(listings, facets, null));
    console.log('      detached from the agent');

    for (const tool of existing) {
      await client.request('DELETE', `/tools/${tool.id}`, undefined, { allowStatuses: [404] });
    }

    let remaining = existing.length;
    for (let i = 0; i < 20 && remaining > 0; i++) {
      await sleep(1500);
      remaining = (await findSearchTools(client)).length;
    }
    if (remaining > 0) {
      throw new Error(
        `${remaining} old "${SEARCH_TOOL_NAME}" tool(s) could not be deleted — ` +
          'deletion has not completed yet, or another agent still references them — rerun once it has.',
      );
    }
    console.log(`      removed ${existing.length} previous version(s)`);
  }

  const code = await readFile(join(ROOT, 'vectara', 'search_properties.py'), 'utf8');
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
        'price, property type, floor) plus the user\'s own words for ranking. Returns the ' +
        'normalised criteria; the matching listings are delivered in the following message.',
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
  const created = await putAgent(client, await agentConfig(listings, facets, searchToolId));
  console.log(created ? '      created' : '      updated in place');
}

async function main() {
  // Re-indexing 400 documents is slow and usually unnecessary when only the
  // prompt changed, so allow the steps to be run independently.
  const { agentOnly, skipIndex } = OPTIONS;

  const client = clientFromEnv();
  const listings = await readJson<Listing[]>('listings.json');
  const facets = await readJson<Facets>('facets.json');

  if (!agentOnly) await ensureCorpus(client);
  if (skipIndex) console.log('\n[2/4] Indexing skipped (--skip-index)');
  else await indexListings(client, listings);
  const searchToolId = await ensureSearchTool(client, listings, facets);
  await ensureAgent(client, listings, facets, searchToolId);

  console.log(`\nDone.\n  corpus: ${CORPUS_KEY}\n  agent:  ${AGENT_KEY}\n  model:  ${JSON.stringify(modelBlock(OPTIONS))}`);
}

main().catch((err) => {
  if (err instanceof VectaraError) console.error(`\n${err.message}\n${err.body}`);
  else console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
