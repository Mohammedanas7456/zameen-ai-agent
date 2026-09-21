import { useCallback, useEffect, useRef, useState } from 'react';
import type { Booking, Facets, Listing, SearchFilters } from '@zameen/shared';
import { AccountChip } from './components/AccountChip.js';
import { BookingModal } from './components/BookingModal.js';
import { ChatPanel } from './components/ChatPanel.js';
import { FilterBar } from './components/FilterBar.js';
import { ResultsGrid } from './components/ResultsGrid.js';
import { createSession, getFacets, searchListings, streamChat } from './lib/api.js';
import { getMe, signOut, slotRangeLabel, type Me } from './lib/booking.js';
import { deleteSession, loadSessions, saveSession, type StoredSession } from './lib/chat-history.js';
import { GREETING, type ChatMessage } from './lib/chat-session.js';
import { canonicalArea, filtersFromExpression } from './lib/filters.js';

export default function App() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [history, setHistory] = useState<StoredSession[]>(() => loadSessions());
  const [listings, setListings] = useState<Listing[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [chatBusy, setChatBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'idle' | 'agent' | 'filters'>('idle');
  const [me, setMe] = useState<Me | null>(null);
  const [booking, setBooking] = useState<Listing | null>(null);
  const [startingChat, setStartingChat] = useState(false);

  // Guards a filter-driven search from racing an in-flight agent turn.
  const searchToken = useRef(0);

  /**
   * Mint a conversation session and adopt it.
   *
   * Shared by the first load and by "New chat" so both succeed and fail the
   * same way. It rejects rather than swallowing, leaving each caller to decide
   * what a failure means for it.
   */
  const startSession = useCallback(async () => {
    const { sessionKey: key } = await createSession();
    setSessionKey(key);
  }, []);

  useEffect(() => {
    getFacets().then(setFacets).catch(() => setFacets(null));
    // A reload should land back in the conversation that was open, not in a
    // fresh one. History is most-recent first; a session that has since
    // expired on the server is handled when the next message is sent.
    const recent = loadSessions()[0];
    if (recent) {
      setSessionKey(recent.sessionKey);
      setMessages(recent.messages);
    } else {
      startSession().catch((e: Error) =>
        setError(`Could not connect to the assistant: ${e.message}`),
      );
    }
    getMe().then(setMe).catch(() => setMe({ buyer: null, bookingEnabled: false }));
  }, [startSession]);

  /**
   * Start a fresh conversation without a page reload.
   *
   * Only the chat resets: the listings, filters and results grid stay put, so
   * the properties on screen survive a new question. A failure keeps the
   * existing session and transcript — a new chat that could not start leaves a
   * working conversation rather than a dead one.
   */
  const handleNewChat = useCallback(async () => {
    setStartingChat(true);
    try {
      await startSession();
      setMessages([GREETING]);
      setError(null);
    } catch (e) {
      setError(`Could not start a new chat: ${(e as Error).message}`);
    } finally {
      setStartingChat(false);
    }
  }, [startSession]);

  /**
   * Persist the current transcript to browser-local history once a turn
   * finishes (never mid-stream, so a long reply isn't re-serialized on every
   * token). A no-op until the first user message exists, so a fresh or
   * newly-started chat doesn't clutter the list.
   */
  useEffect(() => {
    if (!sessionKey || chatBusy) return;
    saveSession(sessionKey, messages);
    setHistory(loadSessions());
  }, [sessionKey, messages, chatBusy]);

  /** Reopen a past chat: adopt its session key so new messages continue it. */
  const handleSelectSession = useCallback((key: string) => {
    const found = loadSessions().find((s) => s.sessionKey === key);
    if (!found) return;
    setSessionKey(found.sessionKey);
    setMessages(found.messages);
    setError(null);
  }, []);

  const handleDeleteSession = useCallback(
    (key: string) => {
      deleteSession(key);
      setHistory(loadSessions());
      // The active chat was deleted out from under itself — start clean.
      if (key === sessionKey) void handleNewChat();
    },
    [sessionKey, handleNewChat],
  );

  /** Sidebar-driven search: deterministic, no LLM. */
  const runFilterSearch = useCallback(async (next: SearchFilters) => {
    const token = ++searchToken.current;
    setSearchBusy(true);
    setSource('filters');
    try {
      const { listings: found } = await searchListings(next);
      // Ignore a response that a newer search has already superseded.
      if (token === searchToken.current) {
        setListings(found);
        setError(null);
      }
    } catch (e) {
      if (token === searchToken.current) setError((e as Error).message);
    } finally {
      if (token === searchToken.current) setSearchBusy(false);
    }
  }, []);

  const handleFiltersChange = useCallback(
    (next: SearchFilters) => {
      setFilters(next);
      if (Object.keys(next).length > 0) void runFilterSearch(next);
      else {
        setListings([]);
        setSource('idle');
      }
    },
    [runFilterSearch],
  );

  const handleReset = useCallback(() => {
    setFilters({});
    setListings([]);
    setSource('idle');
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOut().catch(() => {});
    setMe((prev) => (prev ? { ...prev, buyer: null } : prev));
  }, []);

  const handleBooked = useCallback((made: Booking) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-${made.eventId}`,
        role: 'system',
        content: `Viewing booked for ${slotRangeLabel(made.startIso, made.endIso)}. An invite is on its way to ${made.buyerEmail}.`,
      },
    ]);
  }, []);

  // Memoize to prevent the focus-trap effect from re-running on every App render.
  // App re-renders once per streamed chat token, which would otherwise tear down and
  // re-run the modal's focus effect many times per second, silently stealing focus.
  const closeBooking = useCallback(() => setBooking(null), []);

  const handleSend = useCallback(
    async (text: string) => {
      if (!sessionKey) {
        setError('Still connecting to the assistant — try again in a moment.');
        return;
      }

      const replyId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: 'user', content: text },
        { id: replyId, role: 'assistant', content: '', streaming: true },
      ]);
      setChatBusy(true);
      setError(null);

      const patch = (update: Partial<ChatMessage>) =>
        setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, ...update } : m)));

      let expired = false;
      const stream = (key: string) =>
        streamChat(key, text, (event) => {
          switch (event.type) {
            case 'token':
              setMessages((prev) =>
                prev.map((m) => (m.id === replyId ? { ...m, content: m.content + event.text } : m)),
              );
              break;
            case 'tool_start':
              // A new agent search invalidates any in-flight sidebar search.
              searchToken.current++;
              patch({ activity: { query: event.query, filter: event.filter } });
              break;
            case 'listings':
              setListings(event.listings);
              setSource('agent');
              setFilters(filtersFromExpression(event.filter));
              break;
            case 'error':
              if (event.code === 'session_expired') expired = true;
              else setError(event.message);
              break;
            case 'done':
              break;
            default:
              break;
          }
        });

      try {
        await stream(sessionKey);

        // The server no longer has this session. Start a new one, say so in
        // the transcript, and send the message again — once. The assistant
        // will not remember earlier turns, which is what the note explains.
        if (expired) {
          expired = false;
          const { sessionKey: fresh } = await createSession();
          setSessionKey(fresh);
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== replyId),
            {
              id: `sys-expired-${Date.now()}`,
              role: 'system',
              content: 'That chat had expired, so a new session was started. The assistant will not remember the earlier messages.',
            },
            { id: replyId, role: 'assistant', content: '', streaming: true },
          ]);
          await stream(fresh);
          if (expired) setError('Could not reach the assistant. Please try again.');
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        patch({ streaming: false, activity: null });
        // A turn that failed — upstream error, context limit, an interruption,
        // or a session that could not be replaced — leaves a reply with
        // nothing in it. The error banner is what the user reads; an empty
        // bubble under it just looks like the assistant went quiet.
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content === '')));
        setChatBusy(false);
      }
    },
    [sessionKey],
  );

  // The agent writes areas lowercase; show the canonical casing in the sidebar.
  const displayFilters: SearchFilters = {
    ...filters,
    ...(filters.area ? { area: canonicalArea(filters.area, facets) } : {}),
    ...(filters.areas?.length
      ? { areas: filters.areas.map((a) => canonicalArea(a, facets)) }
      : {}),
  };

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex items-center gap-3 border-b px-4 py-2.5"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          Z
        </div>
        <div className="flex-1">
          <h1 className="text-sm font-bold leading-tight">Zameen AI</h1>
          <p className="text-[11px] leading-tight" style={{ color: 'var(--muted)' }}>
            Karachi property search · powered by Vectara
          </p>
        </div>
        {facets && (
          <div className="hidden gap-4 text-right sm:flex">
            {[
              { label: 'Listings', value: facets.total },
              { label: 'For rent', value: facets.purposes.find((p) => p.name === 'rent')?.count ?? 0 },
              { label: 'For sale', value: facets.purposes.find((p) => p.name === 'buy')?.count ?? 0 },
            ].map((s) => (
              <div key={s.label}>
                <p className="text-sm font-bold leading-tight">{s.value}</p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        )}
        <AccountChip me={me} onSignOut={handleSignOut} />
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          className="flex h-[45vh] shrink-0 border-b lg:h-auto lg:w-[380px] lg:border-b-0 lg:border-r xl:w-[420px]"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="min-w-0 flex-1">
            <ChatPanel
              messages={messages}
              onSend={handleSend}
              onNewChat={handleNewChat}
              busy={chatBusy}
              startingChat={startingChat}
              error={error}
              history={history}
              activeSessionKey={sessionKey}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
            />
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FilterBar
            facets={facets}
            filters={displayFilters}
            onChange={handleFiltersChange}
            onReset={handleReset}
            resultCount={listings.length}
            busy={searchBusy}
          />
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
            <ResultsGrid
              listings={listings}
              busy={searchBusy}
              source={source}
              onBook={setBooking}
              bookingEnabled={me?.bookingEnabled ?? false}
            />
          </div>
        </section>
      </main>

      {booking && (
        <BookingModal
          listing={booking}
          me={me}
          onClose={closeBooking}
          onBooked={handleBooked}
        />
      )}
    </div>
  );
}
