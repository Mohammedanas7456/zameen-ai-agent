import type { Facets, Listing, SearchFilters } from '@zameen/shared';

/** Events the server streams during a chat turn. */
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; tool: string; query: string; filter: string }
  | { type: 'listings'; listings: Listing[]; filter: string }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: 'upstream' | 'context_limit' | 'interrupted' | 'session_expired' };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const getFacets = () => json<Facets>('/api/facets');

export const createSession = () =>
  json<{ sessionKey: string }>('/api/session', { method: 'POST', body: '{}' });

export const searchListings = (filters: SearchFilters, query = '') =>
  json<{ listings: Listing[] }>('/api/search', {
    method: 'POST',
    body: JSON.stringify({ filters, query }),
  });

/**
 * Stream one chat turn, invoking `onEvent` as the server emits.
 *
 * Uses fetch + a reader rather than EventSource because the turn is a POST and
 * needs a body. The returned promise settles when the stream ends.
 */
export async function streamChat(
  sessionKey: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey, message }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    onEvent({ type: 'error', message: body.error ?? `Chat failed (${res.status})` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; keep any partial tail buffered.
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
      } catch {
        // A malformed frame shouldn't kill the stream.
      }
    }
  }
}
