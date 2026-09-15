/**
 * Server-sent-event plumbing: parse Vectara's stream, and re-emit a smaller,
 * UI-shaped stream to the browser.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incrementally parse an SSE byte stream into events.
 *
 * Chunk boundaries fall anywhere, so this buffers until it sees a blank line
 * (the SSE record separator) and handles both `\n\n` and `\r\n\r\n`.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // Normalise CRLF so a single split handles both line-ending styles.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');

    let separator: number;
    while ((separator = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);

      let eventName: string | undefined;
      const dataLines: string[] = [];

      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        // ':' comment lines and unknown fields are ignored per the SSE spec.
      }

      if (dataLines.length > 0) {
        events.push({ ...(eventName ? { event: eventName } : {}), data: dataLines.join('\n') });
      }
    }

    return events;
  }
}

/** Events this server sends to the browser. */
export type ClientEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; tool: string; query: string; filter: string }
  | { type: 'listings'; listings: unknown[]; filter: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Dig the query and metadata filter out of a tool_input payload.
 *
 * The model is instructed to pass `search.corpora[0].metadata_filter`, but a
 * model can always deviate, so this looks for the filter anywhere in the
 * payload rather than trusting one exact path. An empty string means the turn
 * ran unfiltered — worth surfacing, because it is a real failure mode.
 */
export function describeToolInput(input: unknown): { query: string; filter: string } {
  let query = '';
  let filter = '';

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'metadata_filter' && typeof value === 'string' && !filter) filter = value;
      else if (key === 'query' && typeof value === 'string' && !query) query = value;
      else walk(value, depth + 1);
    }
  };

  walk(input, 0);
  return { query, filter };
}
