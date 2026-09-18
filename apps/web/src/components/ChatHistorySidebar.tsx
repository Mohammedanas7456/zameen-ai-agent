import type { StoredSession } from '../lib/chat-history.js';

interface Props {
  sessions: StoredSession[];
  activeSessionKey: string | null;
  onSelect: (sessionKey: string) => void;
  onDelete: (sessionKey: string) => void;
  onClose: () => void;
}

/** Relative-enough for a chat list: exact for today, otherwise a short date. */
function dateLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Slide-over panel listing past chats, scoped to the chat column it overlays.
 *
 * Backed by `localStorage` (see `chat-history.ts`) rather than a server, so
 * this is the entire UI for "previous chats" — there is no separate history
 * page or endpoint to keep in sync with.
 */
export function ChatHistorySidebar({ sessions, activeSessionKey, onSelect, onDelete, onClose }: Props) {
  return (
    <div className="absolute inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close chat history"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div
        role="dialog"
        aria-label="Chat history"
        className="scroll-slim relative flex h-full w-full max-w-[280px] flex-col overflow-y-auto border-r shadow-xl"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center gap-2 border-b px-3 py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2
            className="flex-1 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--muted)' }}
          >
            Chat history
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-sm hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: 'var(--muted)' }}
          >
            ✕
          </button>
        </div>

        {sessions.length === 0 ? (
          <p className="px-3 py-4 text-xs" style={{ color: 'var(--muted)' }}>
            No previous chats yet — conversations you have appear here once you send a message.
          </p>
        ) : (
          <ul className="flex-1 space-y-0.5 p-1.5">
            {sessions.map((s) => (
              <li key={s.sessionKey} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect(s.sessionKey)}
                  className={`min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    s.sessionKey === activeSessionKey ? 'bg-brand-600/10' : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <p className="truncate font-medium" style={{ color: 'var(--text)' }}>
                    {s.title}
                  </p>
                  <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    {dateLabel(s.updatedAt)}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(s.sessionKey)}
                  aria-label={`Delete chat: ${s.title}`}
                  className="shrink-0 rounded p-1.5 text-xs opacity-0 transition hover:bg-black/5 group-hover:opacity-100 dark:hover:bg-white/5"
                  style={{ color: 'var(--muted)' }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
