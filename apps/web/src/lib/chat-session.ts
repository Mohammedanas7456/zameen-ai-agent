/**
 * Shape and lifecycle of the chat transcript.
 *
 * This lives outside `ChatPanel` because it is session data rather than a
 * rendering concern: `App` owns the transcript, `ChatPanel` only draws it, and
 * keeping it here lets the reset rule be unit-tested without a DOM.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Set while the assistant is mid-search, to show what it is doing. */
  activity?: { query: string; filter: string } | null;
  streaming?: boolean;
}

/** The message every transcript — the first and each new one — starts from. */
export const GREETING: ChatMessage = {
  id: 'greeting',
  role: 'assistant',
  content:
    "Hello! I can help you find a property in Karachi.\nWhich **area or town** are you looking in?",
};

interface NewChatState {
  /** How many messages the transcript currently holds. */
  messageCount: number;
  /** A turn is streaming. */
  chatBusy: boolean;
  /** A replacement session is already being minted. */
  starting: boolean;
}

/**
 * Whether "New chat" should be clickable.
 *
 * Off mid-turn (the reply would stream into a transcript that no longer
 * exists), off while a session is already being minted (a double click would
 * race two `/api/session` calls), and off for a transcript that is still just
 * the greeting — there is nothing to clear, so the click would only spend a
 * session to stand still.
 */
export function canStartNewChat({ messageCount, chatBusy, starting }: NewChatState): boolean {
  return messageCount > 1 && !chatBusy && !starting;
}
