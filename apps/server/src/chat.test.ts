import { describe, it, expect, vi } from 'vitest';
import type { Listing, SearchFilters } from '@zameen/shared';
import type { ClientEvent } from './sse.js';

// chat.ts imports vectara.ts for its default dependencies, and vectara.ts
// reaches config.ts, which calls required('VECTARA_API_KEY') at import time.
process.env['VECTARA_API_KEY'] ??= 'test-key';

const { handleUserMessage, MAX_SEARCHES_PER_MESSAGE } = await import('./chat.js');

/** One Vectara SSE stream, framed the way the events endpoint sends it. */
function stream(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

const prose = (content: string) => ({ type: 'streaming_agent_output', content });

const toolInput = (tool_input: object) => ({
  type: 'tool_input',
  tool_call_id: 'call-1',
  tool_configuration_name: 'search_properties',
  tool_name: 'search_properties',
  tool_input,
});

const toolOutput = (tool_output: object, error = false) => ({
  type: 'tool_output',
  tool_call_id: 'call-1',
  tool_configuration_name: 'search_properties',
  tool_name: 'search_properties',
  tool_output,
  error,
});

/** A lambda reply that accepted the call with the given normalised criteria. */
const accepted = (criteria: object, warnings: string[] = []) =>
  toolOutput({ status: 'searching', criteria, warnings, note: 'listings follow' });

const LISTING = {
  externalId: '12345', title: 'Well kept 3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 250_000,
  priceLabel: 'PKR 2.5 Lakh', rentFrequency: null, areaSqft: 1800, areaSqyd: 200,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Clifton > Block 2',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

type Search = (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]>;

/**
 * Wire the loop to scripted agent turns. Each entry in `turns` is the stream
 * one call to streamAgentTurn returns, in order.
 */
function harness(turns: object[][], results: Listing[] | Error = [LISTING]) {
  const events: ClientEvent[] = [];
  const streamAgentTurn = vi.fn<(sessionKey: string, message: string) => Promise<Response>>();
  for (const t of turns) streamAgentTurn.mockResolvedValueOnce(stream(t));
  const searchListings = vi.fn<Search>(async () => {
    if (results instanceof Error) throw results;
    return results;
  });
  return {
    events,
    streamAgentTurn,
    searchListings,
    run: (message = 'hello', isAborted: () => boolean = () => false) =>
      handleUserMessage('sess', message, (e) => events.push(e), isAborted, { streamAgentTurn, searchListings }),
    /** Every message sent to the agent, in order. Index 0 is the user's. */
    sent: () => streamAgentTurn.mock.calls.map((c) => c[1]),
  };
}

const tokens = (events: ClientEvent[]) =>
  events.filter((e): e is { type: 'token'; text: string } => e.type === 'token').map((e) => e.text).join('');

describe('handleUserMessage', () => {
  it('forwards prose and searches nothing when the agent only talks', async () => {
    const h = harness([[prose('Which area '), prose('are you looking in?')]]);
    await h.run();
    expect(tokens(h.events)).toBe('Which area are you looking in?');
    expect(h.searchListings).not.toHaveBeenCalled();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("builds the search from the lambda's normalised criteria, not the raw arguments", async () => {
    const h = harness([
      [
        toolInput({ purpose: 'rent', area: 'DHA Phase 6', min_bedrooms: 3, property_type: 'apartment' }),
        accepted({ purpose: 'rent', area: 'DHA Phase 6', min_bedrooms: 3 }, [
          "'apartment' is not a known property type and was ignored",
        ]),
        prose('Searching now.'),
      ],
      [prose('One listing matched.')],
    ]);
    await h.run('3 bed apartment in DHA Phase 6');

    expect(h.searchListings).toHaveBeenCalledTimes(1);
    expect(h.searchListings.mock.calls[0]?.[0]).toEqual({ purpose: 'rent', area: 'DHA Phase 6', minBedrooms: 3 });

    const start = h.events.find((e) => e.type === 'tool_start') as { filter: string };
    expect(start.filter).not.toContain('property_type');
    expect(h.events.some((e) => e.type === 'listings')).toBe(true);

    // The throwaway acknowledgement is dropped; the narration is forwarded.
    expect(tokens(h.events)).toBe('One listing matched.');

    const results = h.sent()[1]!;
    expect(results).toContain('SEARCH RESULTS');
    expect(results).toContain("Ignored: 'apartment' is not a known property type and was ignored.");
    expect(results).toContain('Well kept 3 bed flat');
    expect(results).toContain(`Searches remaining for this message: ${MAX_SEARCHES_PER_MESSAGE - 1}.`);
  });

  it('falls back to the raw arguments when the lambda itself failed', async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', area: 'Clifton' }), toolOutput({ message: 'sandbox timeout' }, true), prose('ok')],
      [prose('done')],
    ]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[0]).toEqual({ purpose: 'rent', area: 'Clifton' });
  });

  it('does not search when the lambda rejected the call, and lets the agent answer', async () => {
    const h = harness([
      [
        toolInput({ purpose: 'lease' }),
        toolOutput({ status: 'error', error: "purpose must be either 'rent' or 'buy'", criteria: {} }),
        prose('Do you want to rent or buy?'),
      ],
    ]);
    await h.run();
    expect(h.searchListings).not.toHaveBeenCalled();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
    expect(tokens(h.events)).toBe('Do you want to rent or buy?');
  });

  it("ranks by the user's own words when the agent passes a query", async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', query: 'sea facing' }), accepted({ purpose: 'rent', query: 'sea facing' })],
      [prose('x')],
    ]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[1]).toBe('sea facing');
    expect(h.sent()[1]).toContain('Ranked by: "sea facing".');
  });

  it('falls back to describing the filters as the query when none was given', async () => {
    const h = harness([[toolInput({ purpose: 'rent', area: 'Clifton' }), accepted({ purpose: 'rent', area: 'Clifton' })], [prose('x')]]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[1]).toBe('for rent, in Clifton');
    expect(h.sent()[1]).not.toContain('Ranked by');
  });

  it('reports a failed search to the client and still gives the agent a turn', async () => {
    const h = harness(
      [[toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })], [prose('Sorry, please try again.')]],
      new Error('HTTP 503'),
    );
    await h.run();
    expect(h.events).toContainEqual({ type: 'error', message: 'Search failed: HTTP 503' });
    expect(h.sent()[1]).toContain('could not be completed');
    expect(tokens(h.events)).toBe('Sorry, please try again.');
  });

  it('honours a second search the agent runs to relax a filter', async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', max_price: 100_000 }), accepted({ purpose: 'rent', max_price: 100_000 })],
      [
        toolInput({ purpose: 'rent', max_price: 150_000 }),
        accepted({ purpose: 'rent', max_price: 150_000 }),
        prose('Nothing under 1 lakh, widening.'),
      ],
      [prose('Here is one under 1.5 lakh.')],
    ]);
    await h.run();
    expect(h.searchListings).toHaveBeenCalledTimes(2);
    expect(h.searchListings.mock.calls[1]?.[0]).toEqual({ purpose: 'rent', maxPrice: 150_000 });
    expect(tokens(h.events)).toBe('Here is one under 1.5 lakh.');
    expect(h.sent()[2]).toContain(`Searches remaining for this message: ${MAX_SEARCHES_PER_MESSAGE - 2}.`);
    expect(h.events.filter((e) => e.type === 'listings')).toHaveLength(2);
  });

  it('stops at the search limit and gives the agent one text-only turn to answer', async () => {
    const call = () => [toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' }), prose('Searching…')];
    const h = harness([call(), call(), call(), call(), [prose('Here is what I found.')]]);
    await h.run();
    expect(h.searchListings).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE);
    // The user's turn, one results turn per search, and the text-only turn.
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE + 2);
    expect(h.sent()[MAX_SEARCHES_PER_MESSAGE]).toContain('Do not call search_properties again');
    expect(h.sent()[MAX_SEARCHES_PER_MESSAGE + 1]).toContain('SEARCH LIMIT');
    expect(tokens(h.events)).toBe('Here is what I found.');
  });

  it('needs no extra turn when the agent respects the limit', async () => {
    const call = () => [toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })];
    const h = harness([call(), call(), call(), [prose('Final answer.')]]);
    await h.run();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE + 1);
    expect(tokens(h.events)).toBe('Final answer.');
  });

  it('probes relaxations when nothing matched and reports the counts', async () => {
    const h = harness([
      [
        toolInput({ purpose: 'rent', area: 'Clifton', max_price: 100_000 }),
        accepted({ purpose: 'rent', area: 'Clifton', max_price: 100_000 }),
      ],
      [prose('Nothing matched.')],
    ]);
    h.searchListings.mockImplementation(async (f) => (f.area ? [] : [LISTING, LISTING]));
    await h.run();
    const results = h.sent()[1]!;
    expect(results).toContain('No listings matched those criteria.');
    expect(results).toContain('with the budget raised to PKR 125,000: 0 listings');
    expect(results).toContain('anywhere in Karachi: 2 listings');
    expect(results).toContain('suggest the most useful relaxation');
  });

  it('stops doing work once the client has gone away', async () => {
    let aborted = false;
    const h = harness([[toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })], [prose('never sent')]]);
    h.searchListings.mockImplementation(async () => {
      aborted = true;
      return [LISTING];
    });
    await h.run('hello', () => aborted);
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.type === 'listings')).toBe(false);
  });
});
