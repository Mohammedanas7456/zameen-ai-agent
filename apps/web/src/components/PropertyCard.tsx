import type { Listing } from '@zameen/shared';
import { compactArea, floorLabel, priceWithPeriod, truncate } from '../lib/format.js';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

interface Props {
  listing: Listing;
  index: number;
  onBook?: (listing: Listing) => void;
  bookingEnabled?: boolean;
}

/**
 * The outer element is a div, not an anchor: the card carries two actions now,
 * and a <button> inside an <a> is invalid HTML whose click would navigate to
 * Zameen instead of opening the booking modal. The anchor covers the media and
 * body; the button is its sibling in the footer.
 */
export function PropertyCard({ listing, index, onBook, bookingEnabled = false }: Props) {
  const floor = floorLabel(listing);

  return (
    <div
      className="group animate-rise flex flex-col overflow-hidden rounded-xl border transition
                 hover:-translate-y-0.5 hover:shadow-lg focus-within:ring-2 focus-within:ring-brand-500"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--border)',
        // Stagger the entrance so a grid of results cascades in.
        animationDelay: `${Math.min(index, 12) * 30}ms`,
      }}
    >
      <a
        href={listing.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-1 flex-col focus:outline-none"
      >
        <div className="relative h-40 overflow-hidden bg-slate-200 dark:bg-slate-800">
          {listing.coverPhoto ? (
            <img
              src={listing.coverPhoto}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <div
              className="flex h-full items-center justify-center text-xs"
              style={{ color: 'var(--muted)' }}
            >
              No photo
            </div>
          )}

          <div className="absolute left-2 top-2 flex gap-1.5">
            <span
              className={`rounded-md px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur ${
                listing.purpose === 'rent' ? 'bg-sky-600/90' : 'bg-brand-600/90'
              }`}
            >
              {listing.purpose === 'rent' ? 'For Rent' : 'For Sale'}
            </span>
            {listing.isVerified && (
              <span className="rounded-md bg-amber-500/90 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                Verified
              </span>
            )}
          </div>

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-6">
            <p className="text-base font-bold text-white">{priceWithPeriod(listing)}</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-3 p-3">
          <div>
            <h3 className="text-sm font-semibold leading-snug">{truncate(listing.title, 64)}</h3>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {listing.areaPath || listing.city}
            </p>
          </div>

          <div className="mt-auto grid grid-cols-3 gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border)' }}>
            <Stat label="Beds" value={listing.bedrooms > 0 ? String(listing.bedrooms) : '—'} />
            <Stat label="Baths" value={listing.bathrooms > 0 ? String(listing.bathrooms) : '—'} />
            <Stat label="Area" value={compactArea(listing.areaSqft)} />
          </div>

          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
            <span>{listing.propertyType}</span>
            {floor && (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border)' }}>
                {floor}
              </span>
            )}
          </div>
        </div>
      </a>

      {onBook && (
        <div className="border-t p-3 pt-2.5" style={{ borderColor: 'var(--border)' }}>
          <button
            type="button"
            disabled={!bookingEnabled}
            onClick={() => onBook(listing)}
            title={bookingEnabled ? undefined : 'Viewing bookings are not configured on this server.'}
            className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white transition
                       hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Book a viewing
          </button>
        </div>
      )}
    </div>
  );
}
