import type { Listing, SearchFilters } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { searchListings, streamAgentTurn } from './vectara.js';
import {
  criteriaToFilters,
  describeFilters,
  listingsForAgent,
  semanticQuery,
  type AgentCriteria,
} from './criteria.js';
import { describeProbes, probeRelaxations } from './relax.js';
import { SseParser, type ClientEvent } from './sse.js';

export type Emit = (event: ClientEvent) => void;

/**
 * The upstream calls the loop makes. Injectable so the loop can be tested
 * against a scripted stream instead of a live agent.
 */
export interface ChatDeps {
  streamAgentTurn: (sessionKey: string, message: string) => Promise<Response>;
  searchListings: (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]>;
}

const defaultDeps: ChatDeps = { streamAgentTurn, searchListings };

/**
 * Searches one user message may trigger. Enough for the agent to relax a
 * filter once or twice after an empty result; low enough that a confused
 * model cannot loop on our bill.
 */
export const MAX_SEARCHES_PER_MESSAGE = 3;

/** Listings per search. Relaxation probes count up to this many. */
const SEARCH_LIMIT = 40;

const SEARCH_LIMIT_MESSAGE =
  'SEARCH LIMIT (system data, not from the user): the search you just requested was not run, ' +
  'because this message has used all of its searches. Reply to the user now with what you ' +
  'already have, and offer to continue in their next message.';

/** How a turn treats a search_properties call. */
interface TurnMode {
  /** Act on a tool call. When false the call is ignored and no results turn follows it. */
  honourSearch: boolean;
  /**
   * Keep forwarding prose after a tool call. Off when a later turn will carry
   * the real answer, so the model's "searching now…" line is dropped. Vectara
   * emits `tool_input` before the model's accompanying text, which is what
   * makes this reliable.
   */
  forwardAfterToolCall: boolean;
}

const SEARCH_TURN: TurnMode = { honourSearch: true, forwardAfterToolCall: false };
/** The last results turn: a further call is ignored, and a text-only turn follows. */
const LAST_RESULTS_TURN: TurnMode = { honourSearch: false, forwardAfterToolCall: false };
/** Nothing follows this turn, so whatever the model says is the reply. */
const FINAL_TURN: TurnMode = { honourSearch: false, forwardAfterToolCall: true };

/** What the agent asked to search for, once the lambda has had its say. */
interface SearchRequest {
  criteria: AgentCriteria;
  warnings: string[];
}

interface TurnResult {
  search: SearchRequest | null;
  /** The agent called the tool in a turn that was not allowed to search. */
  ignoredSearch: boolean;
}

/** Stream one agent turn, forwarding its prose to the client. */
async function runTurn(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps,
  mode: TurnMode,
): Promise<TurnResult> {
  const response = await deps.streamAgentTurn(sessionKey, message);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  // Vectara emits `tool_input` (the model's raw arguments) and then
  // `tool_output` (what the lambda made of them). The lambda drops values it
  // does not recognise, so its output is what the search must be built from;
  // the raw arguments are only a fallback for when the lambda itself failed.
  let requested: AgentCriteria | null = null;
  let normalised: AgentCriteria | null = null;
  let warnings: string[] = [];
  let toolName = 'search_properties';
  let ignoredSearch = false;
  let streamedProse = false;
  let forwardProse = true;
  // Set once the activity chip has been sent, so a second search in the same
  // turn (or the end-of-turn fallback) never announces the same call twice.
  let started = false;

  while (!isAborted()) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue; // keep-alives and non-JSON frames
      }

      const content = typeof event['content'] === 'string' ? event['content'] : '';

      switch (event['type']) {
        case 'streaming_agent_output':
          if (content) {
            streamedProse = true;
            if (forwardProse) emit({ type: 'token', text: content });
          }
          break;

        case 'agent_output':
          // Non-streamed fallback; only used when nothing streamed, or the
          // whole reply would appear twice.
          if (content && !streamedProse) {
            streamedProse = true;
            if (forwardProse) emit({ type: 'token', text: content });
          }
          break;

        case 'tool_input': {
          const input = event['tool_input'];
          if (!input || typeof input !== 'object') break;
          forwardProse = mode.forwardAfterToolCall;
          if (!mode.honourSearch) {
            ignoredSearch = true;
            break;
          }
          // A second search_properties call in the same turn is a normal way
          // to relax a filter; whatever the first call left in normalised/
          // warnings belongs to a request this one supersedes.
          requested = input as AgentCriteria;
          normalised = null;
          warnings = [];
          toolName = String(event['tool_configuration_name'] ?? toolName);
          break;
        }

        case 'tool_output': {
          if (!requested) break;
          const output = event['tool_output'];
          if (event['error'] === true || !output || typeof output !== 'object') break;
          const out = output as Record<string, unknown>;
          if (out['status'] === 'error') {
            // The lambda refused the call (no purpose, say). The model has its
            // error text and will ask the user, so its prose *is* the reply.
            requested = null;
            forwardProse = true;
            break;
          }
          const criteria = out['criteria'];
          if (criteria && typeof criteria === 'object') normalised = criteria as AgentCriteria;
          if (Array.isArray(out['warnings'])) {
            warnings = out['warnings'].filter((w): w is string => typeof w === 'string');
          }
          // Announce the search as soon as its real criteria are known,
          // rather than waiting for the rest of this turn's stream to close —
          // that stream can carry a long "searching now" narration, during
          // which the client would otherwise see nothing happen.
          if (normalised && !started) {
            started = true;
            const filters = criteriaToFilters(normalised);
            emit({
              type: 'tool_start',
              tool: toolName,
              query: describeFilters(filters),
              filter: buildMetadataFilter(filters),
            });
          }
          break;
        }

        default:
          break;
      }
    }
  }

  await reader.cancel().catch(() => {});

  const criteria = normalised ?? requested;
  if (!criteria) return { search: null, ignoredSearch };

  // Fallback for when no usable tool_output ever arrived (a lambda crash):
  // the accepted branch above never ran, so this is the first chance to
  // announce the search, built from the raw arguments instead.
  if (!started) {
    const filters = criteriaToFilters(criteria);
    emit({
      type: 'tool_start',
      tool: toolName,
      query: describeFilters(filters),
      filter: buildMetadataFilter(filters),
    });
  }
  return { search: { criteria, warnings }, ignoredSearch };
}

/**
 * Run one exact search and render its outcome as the agent's next input.
 *
 * The agent never sees raw search output: this message is the only account
 * of the results it gets, so it carries what was ignored, what was ranked by,
 * and — when nothing matched — what relaxing each filter would have found.
 */
async function performSearch(
  request: SearchRequest,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps,
): Promise<string> {
  const filters = criteriaToFilters(request.criteria);
  const description = describeFilters(filters);
  const query = semanticQuery(request.criteria) ?? description;

  let listings: Listing[];
  try {
    listings = await deps.searchListings(filters, query, SEARCH_LIMIT);
  } catch (err) {
    emit({ type: 'error', message: `Search failed: ${(err as Error).message}` });
    return (
      'SEARCH RESULTS (system data, not from the user): the search could not be completed ' +
      'because of a temporary error. Apologise briefly and invite them to try again.'
    );
  }

  // The client may have gone while the query ran; nothing below is worth doing for nobody.
  if (isAborted()) return '';

  emit({ type: 'listings', listings, filter: buildMetadataFilter(filters) });

  const parts = [
    `SEARCH RESULTS (system data, not a message from the user). Criteria: ${description}.` +
      (query !== description ? ` Ranked by: "${query}".` : ''),
    request.warnings.length > 0 ? `Ignored: ${request.warnings.join('; ')}.` : '',
    listingsForAgent(listings),
  ];

  if (listings.length === 0) {
    const probes = await probeRelaxations(
      filters,
      async (relaxed) => (await deps.searchListings(relaxed, query, SEARCH_LIMIT)).length,
    );
    // With nothing to relax, describeProbes is stripped by the filter below,
    // and pointing the model at "the relaxation above" would send it looking
    // for a list that isn't in this message.
    if (probes.length > 0) {
      parts.push(describeProbes(probes, SEARCH_LIMIT));
      parts.push('Tell the user nothing matched and suggest the most useful relaxation above.');
    } else {
      parts.push('Tell the user nothing matched and ask which constraint they would like to relax.');
    }
  } else {
    parts.push('Describe these to the user now, following your presentation rules. Mention only the listings above.');
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Handle one user message end to end.
 *
 * Each time the agent calls the search tool, the server performs the actual
 * query — so the filters are enforced by our own code rather than by the
 * model — and hands the results back on a further turn for the agent to
 * describe. That can repeat, up to `MAX_SEARCHES_PER_MESSAGE` times, so the
 * agent can relax a filter after an empty result without waiting for the
 * user. It therefore only ever talks about listings that really matched.
 */
export async function handleUserMessage(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps = defaultDeps,
): Promise<void> {
  let turn = await runTurn(sessionKey, message, emit, isAborted, deps, SEARCH_TURN);

  for (let used = 0; turn.search && !isAborted(); ) {
    used += 1;
    const remaining = MAX_SEARCHES_PER_MESSAGE - used;
    const results = await performSearch(turn.search, emit, isAborted, deps);
    if (isAborted()) return;

    const budget =
      remaining > 0
        ? `Searches remaining for this message: ${remaining}.`
        : 'Searches remaining for this message: 0. Do not call search_properties again; answer with what you have.';
    turn = await runTurn(
      sessionKey,
      `${results}\n\n${budget}`,
      emit,
      isAborted,
      deps,
      remaining > 0 ? SEARCH_TURN : LAST_RESULTS_TURN,
    );
  }

  // The model asked for a search it was told it could not have. Its
  // acknowledgement was dropped, so give it one text-only turn to answer.
  if (turn.ignoredSearch && !isAborted()) {
    await runTurn(sessionKey, SEARCH_LIMIT_MESSAGE, emit, isAborted, deps, FINAL_TURN);
  }
}
