/**
 * Browser-local history of past chat sessions.
 *
 * Vectara keeps the actual multi-turn context per `sessionKey` server-side; this
 * only remembers, per browser, which sessions exist and what was said in them, so
 * a past chat can be listed and its transcript redrawn without a backend that
 * tracks users. There is no login in this app, so per-browser is the only identity
 * available — it will not follow someone to another device or survive cleared site
 * data.
 */

import type { ChatMessage } from './chat-session.js';

export interface StoredSession {
  sessionKey: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** What saveSession/loadSessions/deleteSession need from `localStorage`. */
type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'zameen:chat-sessions';
/** Bounds both the stored payload size and how long the list can get. */
const MAX_SESSIONS = 30;
const TITLE_MAX_LEN = 60;

function safeLocalStorage(): SessionStorage {
  try {
    return window.localStorage;
  } catch {
    // Some browsers throw merely on referencing localStorage (e.g. cookies
    // blocked). Fall back to a no-op so history is simply unavailable.
    return { getItem: () => null, setItem: () => {} };
  }
}

function readAll(storage: SessionStorage): StoredSession[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSession[]) : [];
  } catch {
    // Corrupted or foreign data under our key shouldn't break the chat.
    return [];
  }
}

function writeAll(storage: SessionStorage, sessions: StoredSession[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Quota exceeded or a private-mode write rejection: history just doesn't
    // persist this turn.
  }
}

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TITLE_MAX_LEN ? `${trimmed.slice(0, TITLE_MAX_LEN - 1)}…` : trimmed;
}

/** Sessions most-recently-updated first. */
export function loadSessions(storage: SessionStorage = safeLocalStorage()): StoredSession[] {
  return readAll(storage).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Upsert a session's transcript.
 *
 * A no-op until the first user message exists — a transcript that's still just
 * the greeting has nothing worth remembering. Re-saving identical messages
 * (e.g. merely opening a stored chat, which round-trips it back through this
 * function) keeps the original `updatedAt` rather than bumping it, so viewing a
 * chat doesn't reorder the list — only actually talking in it does.
 */
export function saveSession(
  sessionKey: string,
  messages: ChatMessage[],
  storage: SessionStorage = safeLocalStorage(),
): void {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (!firstUserMessage) return;

  const existing = readAll(storage);
  const prior = existing.find((s) => s.sessionKey === sessionKey);
  const unchanged = prior !== undefined && JSON.stringify(prior.messages) === JSON.stringify(messages);

  const entry: StoredSession = {
    sessionKey,
    title: truncateTitle(firstUserMessage.content),
    updatedAt: unchanged ? prior.updatedAt : new Date().toISOString(),
    messages,
  };

  const others = existing.filter((s) => s.sessionKey !== sessionKey);
  const capped = [entry, ...others]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSIONS);
  writeAll(storage, capped);
}

export function deleteSession(
  sessionKey: string,
  storage: SessionStorage = safeLocalStorage(),
): void {
  writeAll(
    storage,
    readAll(storage).filter((s) => s.sessionKey !== sessionKey),
  );
}
