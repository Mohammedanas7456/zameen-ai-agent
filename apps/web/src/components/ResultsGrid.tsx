import type { Listing } from '@zameen/shared';
import { PropertyCard } from './PropertyCard.js';

interface Props {
  listings: Listing[];
  busy: boolean;
  /** Where the current results came from, so the header can say so. */
  source: 'idle' | 'agent' | 'filters';
}

function SkeletonCard() {
  return (
    <div
      className="h-[290px] animate-pulse rounded-xl border"
      style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
    >
      <div className="h-40 rounded-t-xl bg-black/5 dark:bg-white/5" />
      <div className="space-y-2 p-3">
        <div className="h-3 w-3/4 rounded bg-black/5 dark:bg-white/5" />
        <div className="h-3 w-1/2 rounded bg-black/5 dark:bg-white/5" />
        <div className="h-8 rounded bg-black/5 dark:bg-white/5" />
      </div>
    </div>
  );
}

export function ResultsGrid({ listings, busy, source }: Props) {
  if (busy && listings.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full border text-xl"
          style={{ borderColor: 'var(--border)' }}
        >
          🏠
        </div>
        <p className="text-sm font-medium">
          {source === 'idle' ? 'No search yet' : 'No properties match'}
        </p>
        <p className="max-w-xs text-xs" style={{ color: 'var(--muted)' }}>
          {source === 'idle'
            ? 'Tell the assistant which area you want, and whether you are renting or buying.'
            : 'Try widening the price range, lowering the bedroom count, or clearing the floor filter.'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {listings.map((listing, i) => (
        <PropertyCard key={`${listing.purpose}-${listing.externalId}`} listing={listing} index={i} />
      ))}
    </div>
  );
}
