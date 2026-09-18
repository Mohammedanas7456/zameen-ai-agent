import { describe, it, expect } from 'vitest';
import { deleteSession, loadSessions, saveSession } from './chat-history.js';
import type { ChatMessage } from './chat-session.js';

/** An in-memory stand-in for `localStorage`, so these tests need no DOM. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const greeting: ChatMessage = { id: 'greeting', role: 'assistant', content: 'Hi there' };
const userMsg = (content: string): ChatMessage => ({ id: `u-${content}`, role: 'user', content });
const assistantMsg = (content: string): ChatMessage => ({ id: `a-${content}`, role: 'assistant', content });

describe('loadSessions', () => {
  it('is empty when nothing has been saved', () => {
    expect(loadSessions(memoryStorage())).toEqual([]);
  });

  it('does not throw on corrupted storage', () => {
    const storage = memoryStorage();
    storage.setItem('zameen:chat-sessions', '{not json');
    expect(loadSessions(storage)).toEqual([]);
  });

  it('orders sessions most-recently-updated first', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('first')], storage);
    saveSession('b', [greeting, userMsg('second')], storage);
    expect(loadSessions(storage).map((s) => s.sessionKey)).toEqual(['b', 'a']);
  });
});

describe('saveSession', () => {
  it('does not store a transcript that is still just the greeting', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting], storage);
    expect(loadSessions(storage)).toEqual([]);
  });

  it('derives the title from the first user message, truncated', () => {
    const storage = memoryStorage();
    const long = 'a'.repeat(80);
    saveSession('a', [greeting, userMsg(long)], storage);
    const [saved] = loadSessions(storage);
    expect(saved!.title).toHaveLength(60);
    expect(saved!.title.endsWith('…')).toBe(true);
  });

  it('upserts by sessionKey, replacing the stored transcript', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('hi')], storage);
    saveSession('a', [greeting, userMsg('hi'), assistantMsg('hello')], storage);
    const sessions = loadSessions(storage);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toHaveLength(3);
  });

  it('keeps the original updatedAt when re-saved with identical messages', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('hi')], storage);
    const first = loadSessions(storage)[0]!.updatedAt;
    saveSession('a', [greeting, userMsg('hi')], storage);
    const second = loadSessions(storage)[0]!.updatedAt;
    expect(second).toBe(first);
  });

  it('bumps updatedAt to the front of the list once the content actually changes', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('hi')], storage);
    saveSession('b', [greeting, userMsg('hey')], storage);
    // 'a' is now stale relative to 'b' — talking in it again should retake the lead.
    saveSession('a', [greeting, userMsg('hi'), assistantMsg('hello')], storage);
    expect(loadSessions(storage).map((s) => s.sessionKey)).toEqual(['a', 'b']);
  });

  it('caps the list, dropping the least-recently-updated sessions', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 35; i++) {
      saveSession(`key-${i}`, [greeting, userMsg(`msg ${i}`)], storage);
    }
    const sessions = loadSessions(storage);
    expect(sessions).toHaveLength(30);
    expect(sessions.map((s) => s.sessionKey)).not.toContain('key-0');
    expect(sessions.map((s) => s.sessionKey)).toContain('key-34');
  });
});

describe('deleteSession', () => {
  it('removes only the named session', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('hi')], storage);
    saveSession('b', [greeting, userMsg('hey')], storage);
    deleteSession('a', storage);
    expect(loadSessions(storage).map((s) => s.sessionKey)).toEqual(['b']);
  });

  it('is a no-op for an unknown key', () => {
    const storage = memoryStorage();
    saveSession('a', [greeting, userMsg('hi')], storage);
    deleteSession('does-not-exist', storage);
    expect(loadSessions(storage)).toHaveLength(1);
  });
});
