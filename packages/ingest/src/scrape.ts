/**
 * Fetch Karachi listing pages from Zameen.com and save the raw hit records.
 *
 * Only the public, robots-permitted listing index paths are used
 * (`/Rentals/...` and `/Homes/...`; the disallowed `/Karachi*` relative-link
 * paths are never touched). Requests are sequential with a delay between them
 * — this pulls 16 pages once, not a crawl.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWindowState, hitsFromState, type RawHit } from './parse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RAW_DIR = join(ROOT, 'data', 'raw');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Zameen serves 25 listings per index page. */
const PER_PAGE = 25;
const TARGET_PER_PURPOSE = 200;
const PAGES = Math.ceil(TARGET_PER_PURPOSE / PER_PAGE);
/** Listings can repeat across pages as results reshuffle, so allow a few
 *  overflow pages to still reach the target after de-duplication. */
const MAX_PAGES = PAGES + 3;
const DELAY_MS = 2000;

const SOURCES = [
  { purpose: 'rent' as const, path: 'Rentals' },
  { purpose: 'buy' as const, path: 'Homes' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url: string, attempt = 1): Promise<string | null> {
  const MAX_ATTEMPTS = 3;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200) return await res.text();
    // 429/5xx are worth retrying; a 404 means we ran past the last page.
    if (res.status === 404) {
      console.warn(`  page not found (end of results): ${url}`);
      return null;
    }
    if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
      const backoff = DELAY_MS * 2 ** attempt;
      console.warn(`  HTTP ${res.status}, retrying in ${backoff}ms (attempt ${attempt + 1})`);
      await sleep(backoff);
      return fetchPage(url, attempt + 1);
    }
    console.error(`  HTTP ${res.status} for ${url} — giving up on this page`);
    return null;
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      const backoff = DELAY_MS * 2 ** attempt;
      console.warn(`  ${(err as Error).message}, retrying in ${backoff}ms`);
      await sleep(backoff);
      return fetchPage(url, attempt + 1);
    }
    console.error(`  failed: ${url} — ${(err as Error).message}`);
    return null;
  }
}

async function scrapePurpose(purpose: 'rent' | 'buy', path: string): Promise<RawHit[]> {
  const collected: RawHit[] = [];
  const seen = new Set<string>();

  console.log(`\n${purpose.toUpperCase()} — target ${TARGET_PER_PURPOSE} listings`);

  for (let page = 1; page <= MAX_PAGES && collected.length < TARGET_PER_PURPOSE; page++) {
    const url = `https://www.zameen.com/${path}/Karachi-2-${page}.html`;
    process.stdout.write(`  page ${page} ... `);

    const html = await fetchPage(url);
    if (!html) {
      console.log('skipped');
      continue;
    }

    const state = extractWindowState(html);
    if (!state) {
      console.log('no window.state — page layout may have changed');
      continue;
    }

    const hits = hitsFromState(state);
    let added = 0;
    for (const hit of hits) {
      const id = String(hit.externalID ?? '');
      // The same listing can appear on two pages if results reshuffle mid-scrape.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      collected.push(hit);
      added++;
      if (collected.length >= TARGET_PER_PURPOSE) break;
    }
    console.log(`${added} new (${collected.length} total)`);

    if (page < MAX_PAGES && collected.length < TARGET_PER_PURPOSE) await sleep(DELAY_MS);
  }

  return collected;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  console.log(`Scraping Zameen.com Karachi listings -> ${RAW_DIR}`);

  let failed = false;
  for (const { purpose, path } of SOURCES) {
    const hits = await scrapePurpose(purpose, path);
    const file = join(RAW_DIR, `${purpose}.json`);
    await writeFile(file, JSON.stringify(hits, null, 2));
    console.log(`  saved ${hits.length} -> ${file}`);
    if (hits.length < TARGET_PER_PURPOSE) {
      console.warn(`  WARNING: only ${hits.length}/${TARGET_PER_PURPOSE} ${purpose} listings`);
      failed = true;
    }
    await sleep(DELAY_MS);
  }

  console.log(failed ? '\nDone, with warnings above.' : '\nDone — full target reached.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
