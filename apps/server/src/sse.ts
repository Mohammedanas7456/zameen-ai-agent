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
  | {
      type: 'error';
      message: string;
      /** Set for failures the client can act on: a new chat fixes
       *  `context_limit` and `session_expired`; the others are informational. */
      code?: 'upstream' | 'context_limit' | 'interrupted' | 'session_expired';
    };
