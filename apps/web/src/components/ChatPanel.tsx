import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Set while the assistant is mid-search, to show what it is doing. */
  activity?: { query: string; filter: string } | null;
  streaming?: boolean;
}

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  busy: boolean;
  error: string | null;
}

const SUGGESTIONS = [
  'Rent a 3 bed flat in DHA Phase 6',
  'Houses to buy in Bahria Town under 3 crore',
  'Ground floor portion in Gulshan-e-Iqbal',
];

/**
 * Render the assistant's markdown-ish output.
 *
 * The agent writes short prose with `**bold**` and `- ` bullets; a full
 * markdown dependency would be overkill for that, so this handles the two
 * constructs it actually emits and escapes everything else as text.
 */
function RichText({ text }: { text: string }) {
  const blocks = text.split('\n').filter((line) => line.trim() !== '');

  return (
    <>
      {blocks.map((line, i) => {
        const bullet = /^\s*[-*]\s+/.test(line);
        const body = bullet ? line.replace(/^\s*[-*]\s+/, '') : line;
        const parts = body.split(/(\*\*[^*]+\*\*)/g);

        const rendered = parts.map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <strong key={j} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <span key={j}>{part}</span>
          ),
        );

        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand-500" />
            <p className="flex-1">{rendered}</p>
          </div>
        ) : (
          <p key={i}>{rendered}</p>
        );
      })}
    </>
  );
}

function ActivityChip({ query, filter }: { query: string; filter: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[11px]"
        style={{ color: 'var(--muted)' }}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500" />
        </span>
        <span className="flex-1 truncate">Searching: {query || 'listings'}</span>
        {filter && <span className="shrink-0">{open ? '▾' : '▸'}</span>}
      </button>
      {open && filter && (
        <pre
          className="scroll-slim mt-1.5 overflow-x-auto rounded bg-black/5 p-2 text-[10px] leading-relaxed dark:bg-white/5"
          style={{ color: 'var(--muted)' }}
        >
          {filter}
        </pre>
      )}
    </div>
  );
}

export function ChatPanel({ messages, onSend, busy, error }: Props) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--panel)' }}>
      <div className="scroll-slim flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => {
          if (m.role === 'system') {
            return (
              <div key={m.id} className="flex justify-center">
                <p
                  className="rounded-lg border px-2.5 py-1.5 text-center text-[11px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  {m.content}
                </p>
              </div>
            );
          }

          return (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'rounded-br-md bg-brand-600 text-white'
                    : 'rounded-bl-md border'
                }`}
                style={
                  m.role === 'assistant'
                    ? { background: 'var(--surface)', borderColor: 'var(--border)' }
                    : undefined
                }
              >
                {m.activity && <ActivityChip query={m.activity.query} filter={m.activity.filter} />}
                <div className="space-y-2">
                  <RichText text={m.content} />
                </div>
                {m.streaming && m.content === '' && !m.activity && (
                  <div className="flex gap-1 py-1">
                    {[0, 150, 300].map((delay) => (
                      <span
                        key={delay}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500"
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {messages.length <= 1 && (
          <div className="space-y-1.5 pt-1">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                disabled={busy}
                className="block w-full rounded-lg border px-3 py-2 text-left text-xs transition
                           hover:border-brand-500 hover:text-brand-700 disabled:opacity-50
                           dark:hover:text-brand-300"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </div>
        )}

        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="border-t p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={busy ? 'Assistant is replying…' : 'Ask about a property…'}
            disabled={busy}
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}
          />
          <button
            type="submit"
            disabled={busy || draft.trim() === ''}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition
                       hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
