import { useCallback, useEffect, useRef, useState } from 'react';
import type { Booking, Facets, Listing, SearchFilters } from '@zameen/shared';
import { AccountChip } from './components/AccountChip.js';
import { BookingModal } from './components/BookingModal.js';
import { ChatPanel, type ChatMessage } from './components/ChatPanel.js';
import { FilterBar } from './components/FilterBar.js';
import { ResultsGrid } from './components/ResultsGrid.js';
import { createSession, getFacets, searchListings, streamChat } from './lib/api.js';
import { getMe, signOut, slotRangeLabel, type Me } from './lib/booking.js';
import { canonicalArea, filtersFromExpression } from './lib/filters.js';

const GREETING: ChatMessage = {
  id: 'greeting',
  role: 'assistant',
  content:
    "Hello! I can help you find a property in Karachi.\nWhich **area or town** are you looking in?",
};

export default function App() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [chatBusy, setChatBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'idle' | 'agent' | 'filters'>('idle');
  const [me, setMe] = useState<Me | null>(null);
  const [booking, setBooking] = useState<Listing | null>(null);

  // Guards a filter-driven search from racing an in-flight agent turn.
  const searchToken = useRef(0);

  useEffect(() => {
    getFacets().then(setFacets).catch(() => setFacets(null));
    createSession()
      .then((r) => setSessionKey(r.sessionKey))
      .catch((e: Error) => setError(`Could not connect to the assistant: ${e.message}`));
    getMe().then(setMe).catch(() => setMe({ buyer: null, bookingEnabled: false }));
  }, []);

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

      try {
        await streamChat(sessionKey, text, (event) => {
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
              setError(event.message);
              break;
            case 'done':
              break;
            default:
              break;
          }
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        patch({ streaming: false, activity: null });
        setChatBusy(false);
      }
    },
    [sessionKey],
  );

  // The agent writes areas lowercase; show the canonical casing in the sidebar.
  const displayFilters: SearchFilters = filters.area
    ? { ...filters, area: canonicalArea(filters.area, facets) }
    : filters;

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
          <div className="flex-1">
            <ChatPanel messages={messages} onSend={handleSend} busy={chatBusy} error={error} />
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
          onClose={() => setBooking(null)}
          onBooked={handleBooked}
        />
      )}
    </div>
  );
}
