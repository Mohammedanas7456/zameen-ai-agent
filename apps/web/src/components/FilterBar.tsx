import { useMemo, useState } from 'react';
import type { Facets, FloorBucket, SearchFilters } from '@zameen/shared';

interface Props {
  facets: Facets | null;
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  onReset: () => void;
  resultCount: number;
  busy: boolean;
}

const FLOORS: { value: FloorBucket; label: string }[] = [
  { value: 'ground', label: 'Ground' },
  { value: 'lower', label: 'Lower' },
  { value: 'upper', label: 'Upper' },
  { value: 'top', label: 'Top' },
];

const fieldClass =
  'w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none transition ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

export function FilterBar({ facets, filters, onChange, onReset, resultCount, busy }: Props) {
  const [expanded, setExpanded] = useState(false);
  const style = { background: 'var(--panel)', borderColor: 'var(--border)', color: 'var(--text)' };

  const set = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    const next = { ...filters };
    if (value === undefined || value === '' || value === null) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const numeric = (raw: string): number | undefined => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  // Areas with only one listing add noise to a dropdown without adding reach.
  const areas = useMemo(() => (facets?.areas ?? []).filter((a) => a.count >= 2), [facets]);

  const activeCount = Object.keys(filters).length;

  return (
    <div className="border-b" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-end gap-2.5 p-3">
        <div className="min-w-[180px] flex-1">
          <Field label="Area / Town">
            <select
              className={fieldClass}
              style={style}
              value={filters.area ?? ''}
              onChange={(e) => set('area', e.target.value || undefined)}
            >
              <option value="">Any area</option>
              {areas.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({a.count})
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="w-[128px]">
          <Field label="Purpose">
            <select
              className={fieldClass}
              style={style}
              value={filters.purpose ?? ''}
              onChange={(e) => set('purpose', (e.target.value || undefined) as SearchFilters['purpose'])}
            >
              <option value="">Rent or buy</option>
              <option value="rent">Rent</option>
              <option value="buy">Buy</option>
            </select>
          </Field>
        </div>

        <div className="w-[104px]">
          <Field label="Min beds">
            <select
              className={fieldClass}
              style={style}
              value={filters.minBedrooms ?? ''}
              onChange={(e) => set('minBedrooms', numeric(e.target.value))}
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}+
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="w-[128px]">
          <Field label="Max price">
            <input
              className={fieldClass}
              style={style}
              type="number"
              min={0}
              step={50000}
              placeholder="PKR"
              value={filters.maxPrice ?? ''}
              onChange={(e) => set('maxPrice', numeric(e.target.value))}
            />
          </Field>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg border px-3 py-1.5 text-sm font-medium transition hover:border-brand-500"
          style={style}
        >
          {expanded ? 'Less' : 'More'} filters
        </button>

        {filters.areas && filters.areas.length > 0 && (
          <p className="w-full text-[11px]" style={{ color: 'var(--muted)' }}>
            Matching {filters.areas.join(', ')} together — the dropdown above shows only one area
            at a time.
          </p>
        )}

        {activeCount > 0 && (
          <button
            onClick={onReset}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30"
          >
            Clear ({activeCount})
          </button>
        )}

        <span className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
          {busy ? 'Searching…' : `${resultCount} ${resultCount === 1 ? 'property' : 'properties'}`}
        </span>
      </div>

      {expanded && (
        <div
          className="grid grid-cols-2 gap-2.5 border-t px-3 pb-3 pt-2.5 sm:grid-cols-4"
          style={{ borderColor: 'var(--border)' }}
        >
          <Field label="Property type">
            <select
              className={fieldClass}
              style={style}
              value={filters.propertyType ?? ''}
              onChange={(e) => set('propertyType', e.target.value || undefined)}
            >
              <option value="">Any type</option>
              {(facets?.propertyTypes ?? []).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.count})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Min price">
            <input
              className={fieldClass}
              style={style}
              type="number"
              min={0}
              step={50000}
              placeholder="PKR"
              value={filters.minPrice ?? ''}
              onChange={(e) => set('minPrice', numeric(e.target.value))}
            />
          </Field>

          <Field label="Min baths">
            <select
              className={fieldClass}
              style={style}
              value={filters.minBathrooms ?? ''}
              onChange={(e) => set('minBathrooms', numeric(e.target.value))}
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}+
                </option>
              ))}
            </select>
          </Field>

          <Field label="Floor (where stated)">
            <select
              className={fieldClass}
              style={style}
              value={filters.floor ?? ''}
              onChange={(e) => set('floor', (e.target.value || undefined) as FloorBucket | undefined)}
            >
              <option value="">Any floor</option>
              {FLOORS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>

          {/* Only ~20% of listings state a floor, so say so rather than letting
              an empty result set look like a bug. */}
          {filters.floor && (
            <p className="col-span-full text-[11px]" style={{ color: 'var(--muted)' }}>
              Only about 1 in 5 listings states a floor, so this narrows results sharply.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
