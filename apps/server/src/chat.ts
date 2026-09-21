import type { Listing, SearchFilters } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { interruptTurn, searchListings, streamAgentTurn } from './vectara.js';
import {
  criteriaToFilters,
  describeFilters,
  listingsForAgent,
  semanticQuery,
  type AgentCriteria,
} from './criteria.js';
import { describeProbes, probeRelaxations } from './relax.js';
import { SseParser, type ClientEvent } from './sse.js';
import { sanitizeText } from './text.js';

export type Emit = (event: ClientEvent) => void;

/**
 * The upstream calls the loop makes. Injectable so the loop can be tested
 * against a scripted stream instead of a live agent.
 */
export interface ChatDeps {
  streamAgentTurn: (sessionKey: string, message: string, signal?: AbortSignal) => Promise<Response>;
  searchListings: (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]>;
  /** Stop a turn the client abandoned. Failures are logged, never surfaced. */
  interruptTurn: (sessionKey: string) => Promise<void>;
  /** Structured log line. Console in production; a spy in tests. */
  log: (entry: Record<string, unknown>) => void;
}

const defaultDeps: ChatDeps = {
  streamAgentTurn,
  searchListings,
  interruptTurn,
  log: (entry) => console.log(JSON.stringify(entry)),
};

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
  /** Every accepted call in this turn, in the order each was first seen. */
  searches: SearchRequest[];
  /** The agent called the tool in a turn that was not allowed to search. */
  ignoredSearch: boolean;
  /** Vectara reported the turn could not complete; nothing further should be sent. */
  failed: boolean;
}

/** One `search_properties` call's state while its turn's stream is still open. */
interface CallState {
  /** The model's raw arguments — kept as the crash fallback. */
  requested: AgentCriteria;
  /** What the lambda normalised the call to, once its tool_output arrives. */
  normalised: AgentCriteria | null;
  warnings: string[];
  /** Set once this call's activity chip has gone out, so neither a later
   *  tool_output for the same id (a replaced request) nor the end-of-turn
   *  fallback ever announces it twice. */
  started: boolean;
  toolName: string;
}

/**
 * Ask Vectara to stop a turn the client left mid-flight. Shared by both
 * places `runTurn` can discover the client is gone: mid-stream, and while
 * the opening POST was still in flight.
 *
 * Awaited, not fired and forgotten: Cloud Run throttles an instance's CPU
 * once no request is in flight, so a pending fetch left behind by a handler
 * that has already returned may never complete. The call carries its own
 * 10 s timeout, so this cannot hold the request open for long. Failures are
 * logged, never surfaced — nobody is left to read them.
 */
async function interruptAbandonedTurn(sessionKey: string, deps: ChatDeps): Promise<void> {
  await deps.interruptTurn(sessionKey).catch((err: unknown) => {
    deps.log({ event: 'interrupt_failed', sessionKey, error: (err as Error).message });
  });
}

/** Stream one agent turn, forwarding its prose to the client. */
async function runTurn(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps,
  mode: TurnMode,
  signal?: AbortSignal,
): Promise<TurnResult> {
  let response: Response;
  try {
    response = await deps.streamAgentTurn(sessionKey, message, signal);
  } catch (err) {
    // The client left while the turn was still being opened — before
    // Vectara's response headers ever arrived. Vectara may already have the
    // message and be generating a reply, so interrupt on the way out just as
    // we would for an abort discovered mid-stream.
    if ((err as Error).name !== 'AbortError') throw err;
    await interruptAbandonedTurn(sessionKey, deps);
    return { searches: [], ignoredSearch: false, failed: false };
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  // Vectara emits `tool_input` (the model's raw arguments) and then
  // `tool_output` (what the lambda made of them). The lambda drops values it
  // does not recognise, so its output is what the search must be built from;
  // the raw arguments are only a fallback for when the lambda itself failed.
  // A turn can carry more than one call, so state is kept per `tool_call_id`,
  // in the order each id was first seen — a Map preserves that order even
  // when a later tool_input for the same id replaces its entry's value.
  const calls = new Map<string, CallState>();
  let anonymousCalls = 0;
  let lastCallId: string | null = null;
  let toolName = 'search_properties';
  let ignoredSearch = false;
  let streamedProse = false;
  let forwardProse = true;
  let failed = false;
  let streamEnded = false;

  try {
    while (!isAborted()) {
      const { done, value } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }

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
            const rawId = event['tool_call_id'];
            const id = typeof rawId === 'string' && rawId ? rawId : `#${anonymousCalls++}`;
            lastCallId = id;
            toolName = String(event['tool_configuration_name'] ?? toolName);
            // A repeat id — the model relaxing its own filter mid-turn — replaces
            // this call's criteria; `started` carries over so a call whose chip
            // already went out never gets a second one for the update.
            const prior = calls.get(id);
            calls.set(id, {
              requested: input as AgentCriteria,
              normalised: null,
              warnings: [],
              started: prior?.started ?? false,
              toolName,
            });
            break;
          }

          case 'tool_output': {
            const rawId = event['tool_call_id'];
            const id = typeof rawId === 'string' && rawId ? rawId : lastCallId;
            if (!id) break;
            const call = calls.get(id);
            if (!call) break;
            const output = event['tool_output'];
            if (event['error'] === true || !output || typeof output !== 'object') break;
            const out = output as Record<string, unknown>;
            if (out['status'] === 'error') {
              // The lambda refused the call (no purpose, say). The model has its
              // error text and will ask the user, so its prose *is* the reply.
              calls.delete(id);
              forwardProse = true;
              break;
            }
            const criteria = out['criteria'];
            if (criteria && typeof criteria === 'object') call.normalised = criteria as AgentCriteria;
            if (Array.isArray(out['warnings'])) {
              call.warnings = out['warnings'].filter((w): w is string => typeof w === 'string');
            }
            // Announce the search as soon as its real criteria are known,
            // rather than waiting for the rest of this turn's stream to close —
            // that stream can carry a long "searching now" narration, during
            // which the client would otherwise see nothing happen.
            if (call.normalised && !call.started) {
              call.started = true;
              const filters = criteriaToFilters(call.normalised);
              emit({
                type: 'tool_start',
                tool: call.toolName,
                query: describeFilters(filters),
                filter: buildMetadataFilter(filters),
              });
            }
            break;
          }

          case 'error': {
            const messages = Array.isArray(event['messages'])
              ? event['messages'].filter((m): m is string => typeof m === 'string')
              : [];
            emit({
              type: 'error',
              code: 'upstream',
              message: `The assistant hit a problem${messages.length > 0 ? `: ${messages.join('; ')}` : ''}.`,
            });
            failed = true;
            break;
          }

          case 'context_limit_exceeded':
            emit({
              type: 'error',
              code: 'context_limit',
              message: 'This conversation has grown too long for the assistant to follow. Start a new chat to continue.',
            });
            failed = true;
            break;

          case 'session_interrupted':
            emit({ type: 'error', code: 'interrupted', message: 'The reply was interrupted before it finished.' });
            failed = true;
            break;

          case 'context_consumed': {
            // The only per-turn token count Vectara gives us; the bill lives here.
            const usage = event['session_context_usage'];
            if (usage && typeof usage === 'object') deps.log({ event: 'turn_usage', sessionKey, usage });
            break;
          }

          default:
            break;
        }
      }
    }
  } catch (err) {
    // An aborted fetch rejects the read that was pending on Vectara's next
    // chunk — that is the client having left, not a failure. `streamEnded`
    // stays false, so execution falls through to the interrupt below.
    if ((err as Error).name !== 'AbortError') throw err;
  }

  await reader.cancel().catch(() => {});

  // The client left while Vectara was still generating. Finishing the turn
  // would only bill for a reply nobody reads.
  if (isAborted() && !streamEnded) {
    await interruptAbandonedTurn(sessionKey, deps);
  }

  // Vectara said the turn could not complete; whatever calls it made are moot.
  if (failed) return { searches: [], ignoredSearch: false, failed };

  const searches: SearchRequest[] = [];
  for (const call of calls.values()) {
    const criteria = call.normalised ?? call.requested;
    // Fallback for when no usable tool_output ever arrived for this call (a
    // lambda crash): the accepted branch above never ran, so this is the
    // first chance to announce it, built from the raw arguments instead.
    if (!call.started) {
      const filters = criteriaToFilters(criteria);
      emit({
        type: 'tool_start',
        tool: call.toolName,
        query: describeFilters(filters),
        filter: buildMetadataFilter(filters),
      });
    }
    searches.push({ criteria, warnings: call.warnings });
  }
  return { searches, ignoredSearch, failed: false };
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
  /** e.g. "1 of 2", when this search is one of several run for the same turn. */
  label?: string,
): Promise<string> {
  const filters = criteriaToFilters(request.criteria);
  // An area reaches this line as the model wrote it, so it is flattened: a
  // newline in it would otherwise forge a further line of this message, which
  // the model reads as our instructions rather than as its own argument.
  const description = sanitizeText(describeFilters(filters), 300);
  const query = semanticQuery(request.criteria) ?? description;

  // A batched turn numbers each block so the model can tell which criteria it
  // belongs to; a lone search keeps the plain heading existing tests assert
  // on. Failures are numbered too — an unnumbered block among numbered ones
  // reads as the results for whichever criteria came last.
  const heading = label ? `SEARCH RESULTS ${label}` : 'SEARCH RESULTS';

  let listings: Listing[];
  try {
    listings = await deps.searchListings(filters, query, SEARCH_LIMIT);
  } catch (err) {
    emit({ type: 'error', message: `Search failed: ${(err as Error).message}` });
    return (
      `${heading} (system data, not from the user): the search could not be completed ` +
      'because of a temporary error. Apologise briefly and invite them to try again.'
    );
  }

  // The client may have gone while the query ran; nothing below is worth doing for nobody.
  if (isAborted()) return '';

  emit({ type: 'listings', listings, filter: buildMetadataFilter(filters) });

  const parts = [
    `${heading} (system data, not a message from the user). Criteria: ${description}.` +
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
  deps: Partial<ChatDeps> = {},
  /** The client's disconnect, so an abort reaches the upstream socket rather
   *  than being noticed only between two of Vectara's chunks. */
  signal?: AbortSignal,
): Promise<void> {
  const d: ChatDeps = { ...defaultDeps, ...deps };
  let turn = await runTurn(sessionKey, message, emit, isAborted, d, SEARCH_TURN, signal);

  for (let used = 0; turn.searches.length > 0 && !turn.failed && !isAborted(); ) {
    // A turn can ask for more than the message has left; run what the budget
    // allows, in call order, and tell the model about the rest so it does not
    // read their absence as the searches simply never having happened.
    const affordable = Math.max(0, MAX_SEARCHES_PER_MESSAGE - used);
    const toRun = turn.searches.slice(0, affordable);
    const skipped = turn.searches.length - toRun.length;

    const blocks: string[] = [];
    for (const [i, search] of toRun.entries()) {
      used += 1;
      const label = toRun.length > 1 ? `${i + 1} of ${toRun.length}` : undefined;
      blocks.push(await performSearch(search, emit, isAborted, d, label));
      if (isAborted()) return;
    }

    const remaining = MAX_SEARCHES_PER_MESSAGE - used;
    const budget =
      remaining > 0
        ? `Searches remaining for this message: ${remaining}.`
        : 'Searches remaining for this message: 0. Do not call search_properties again; answer with what you have.';
    const skippedNote =
      skipped > 0
        ? `${skipped} further search(es) you requested in that turn were not run: this message's search budget is used up.`
        : '';

    turn = await runTurn(
      sessionKey,
      [blocks.join('\n\n---\n\n'), skippedNote, budget].filter(Boolean).join('\n\n'),
      emit,
      isAborted,
      d,
      remaining > 0 ? SEARCH_TURN : LAST_RESULTS_TURN,
      signal,
    );
  }

  // The model asked for a search it was told it could not have. Its
  // acknowledgement was dropped, so give it one text-only turn to answer.
  if (turn.ignoredSearch && !turn.failed && !isAborted()) {
    await runTurn(sessionKey, SEARCH_LIMIT_MESSAGE, emit, isAborted, d, FINAL_TURN, signal);
  }
}
