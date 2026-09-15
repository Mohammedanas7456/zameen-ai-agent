import type { Listing } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { searchListings, streamAgentTurn } from './vectara.js';
import { criteriaToFilters, describeFilters, listingsForAgent, type AgentCriteria } from './criteria.js';
import { SseParser, type ClientEvent } from './sse.js';

export type Emit = (event: ClientEvent) => void;

interface TurnResult {
  /** Criteria the agent asked to search with, if it called the tool. */
  criteria: AgentCriteria | null;
}

/** Stream one agent turn, forwarding its prose to the client. */
async function runTurn(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
): Promise<TurnResult> {
  const response = await streamAgentTurn(sessionKey, message);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  let criteria: AgentCriteria | null = null;
  let streamedProse = false;
  // Prose is forwarded until the agent calls the search tool. Vectara emits
  // `tool_input` before the model's accompanying text, so this reliably
  // suppresses the throwaway "searching now..." line, whose real answer
  // arrives on the next turn.
  let forwardProse = true;

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
          if (input && typeof input === 'object') {
            criteria = input as AgentCriteria;
            forwardProse = false;
            const filters = criteriaToFilters(criteria);
            emit({
              type: 'tool_start',
              tool: String(event['tool_configuration_name'] ?? 'search_properties'),
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
  return { criteria };
}

/**
 * Handle one user message end to end.
 *
 * When the agent decides to search, this runs two turns: the first captures
 * its criteria, then the server performs the actual query — so the filters are
 * enforced by our own code rather than by the model — and the second turn hands
 * the results back for the agent to describe. The agent therefore only ever
 * talks about listings that really matched.
 */
export async function handleUserMessage(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
): Promise<void> {
  const first = await runTurn(sessionKey, message, emit, isAborted);

  if (!first.criteria || isAborted()) return;

  const filters = criteriaToFilters(first.criteria);
  let listings: Listing[] = [];
  let failure: string | null = null;

  try {
    listings = await searchListings(filters, describeFilters(filters));
  } catch (err) {
    failure = (err as Error).message;
  }

  if (isAborted()) return;

  if (failure) {
    emit({ type: 'error', message: `Search failed: ${failure}` });
    // Still give the agent a turn so the user gets a reply rather than silence.
    await runTurn(
      sessionKey,
      'SEARCH RESULTS (system data, not from the user): the search could not be completed ' +
        'because of a temporary error. Apologise briefly and invite them to try again.',
      emit,
      isAborted,
    );
    return;
  }

  emit({ type: 'listings', listings, filter: buildMetadataFilter(filters) });

  const body = listingsForAgent(listings);
  await runTurn(
    sessionKey,
    `SEARCH RESULTS (system data, not a message from the user). Criteria: ${describeFilters(filters)}.\n\n` +
      `${body}\n\n` +
      'Describe these to the user now, following your presentation rules. ' +
      'Mention only the listings above.',
    emit,
    isAborted,
  );
}
