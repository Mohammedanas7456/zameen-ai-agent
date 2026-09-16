import { describe, it, expect } from 'vitest';
import { canStartNewChat, GREETING } from './chat-session.js';

const fresh = { messageCount: 1, chatBusy: false, starting: false };

describe('canStartNewChat', () => {
  it('is off for a transcript that is still just the greeting', () => {
    // Nothing to clear, so a click would only burn a session to stand still.
    expect(canStartNewChat(fresh)).toBe(false);
  });

  it('is on once the conversation has moved past the greeting', () => {
    expect(canStartNewChat({ ...fresh, messageCount: 3 })).toBe(true);
  });

  it('is off while a turn is streaming', () => {
    expect(canStartNewChat({ ...fresh, messageCount: 3, chatBusy: true })).toBe(false);
  });

  it('is off while a session is already being minted', () => {
    // Guards a double click from racing two /api/session calls.
    expect(canStartNewChat({ ...fresh, messageCount: 3, starting: true })).toBe(false);
  });
});

describe('GREETING', () => {
  it('is the assistant message a new transcript starts from', () => {
    expect(GREETING.role).toBe('assistant');
    expect(GREETING.id).toBe('greeting');
    expect(GREETING.content).not.toBe('');
  });
});
