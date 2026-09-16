import { useCallback, useEffect, useRef, useState } from 'react';
import type { Availability, Booking, Listing, Slot } from '@zameen/shared';
import {
  BookingError,
  createBooking,
  dayLabel,
  getAvailability,
  slotLabel,
  slotRangeLabel,
  type Me,
} from '../lib/booking.js';

interface Props {
  listing: Listing;
  me: Me | null;
  onClose: () => void;
  onBooked: (booking: Booking) => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea';

export function BookingModal({ listing, me, onClose, onBooked }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [step, setStep] = useState<'slot' | 'details' | 'done'>('slot');
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [failure, setFailure] = useState<{ field?: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);

  // Google supplies name and email; phone is whatever we remembered from a
  // previous booking, because Google never returns one.
  useEffect(() => {
    if (me?.buyer) setForm({ name: me.buyer.name, email: me.buyer.email, phone: me.buyer.phone });
  }, [me]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getAvailability();
      setAvailability(data);
      const firstOpen = data.days.findIndex((d) => d.slots.some((s) => s.available));
      setDayIndex(firstOpen >= 0 ? firstOpen : 0);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Trap focus inside the dialog, close on Escape, and hand focus back to the
  // button that opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;

    setSubmitting(true);
    setFailure(null);
    try {
      const created = await createBooking({
        purpose: listing.purpose,
        externalId: listing.externalId,
        startIso: selected.startIso,
        buyer: form,
      });
      setBooking(created);
      setStep('done');
      onBooked(created);
    } catch (err) {
      const error = err as BookingError;
      setFailure({ ...(error.field ? { field: error.field } : {}), message: error.message });
      // Someone took the slot while this form was open: go back and refresh the
      // grid, but keep everything they typed.
      if (error.status === 409) {
        setSelected(null);
        setStep('slot');
        void load();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const day = availability?.days[dayIndex];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Book a viewing for ${listing.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="scroll-slim max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border p-5 shadow-xl focus:outline-none"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold leading-tight">Book a viewing</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {listing.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            style={{ borderColor: 'var(--border)' }}
          >
            ✕
          </button>
        </div>

        {step === 'done' && booking ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold">You're booked in.</p>
            <p className="text-sm">{slotRangeLabel(booking.startIso, booking.endIso)}</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              An invite is on its way to {booking.buyerEmail}.
            </p>
            {booking.htmlLink && (
              <a
                href={booking.htmlLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs underline"
              >
                View it in Google Calendar
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Done
            </button>
          </div>
        ) : null}

        {step === 'slot' ? (
          <div className="space-y-3">
            {failure && (
              <p className="rounded-lg border border-amber-500/50 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                {failure.message}
              </p>
            )}

            {loadError && (
              <div className="space-y-2">
                <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
                <button type="button" onClick={() => void load()} className="text-xs underline">
                  Try again
                </button>
              </div>
            )}

            {!availability && !loadError && (
              <div className="h-40 animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
            )}

            {availability && (
              <>
                <p className="text-xs font-medium">Pick a day</p>
                <div className="scroll-slim flex gap-1.5 overflow-x-auto pb-1">
                  {availability.days.map((d, i) => (
                    <button
                      key={d.date}
                      type="button"
                      disabled={!d.open}
                      onClick={() => setDayIndex(i)}
                      className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] transition
                        disabled:cursor-not-allowed disabled:opacity-35
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                        ${i === dayIndex ? 'bg-brand-600 text-white' : ''}`}
                      style={i === dayIndex ? {} : { borderColor: 'var(--border)' }}
                    >
                      {dayLabel(d.date)}
                    </button>
                  ))}
                </div>

                <p className="text-xs font-medium">
                  Pick a time{availability.slotMinutes ? ` (${availability.slotMinutes} minutes)` : ''}
                </p>
                {day?.open ? (
                  <div className="grid grid-cols-4 gap-1.5">
                    {day.slots.map((slot) => (
                      <button
                        key={slot.startIso}
                        type="button"
                        disabled={!slot.available}
                        onClick={() => {
                          setSelected(slot);
                          setStep('details');
                          setFailure(null);
                        }}
                        className="rounded-lg border px-2 py-1.5 text-[11px] transition
                                   enabled:hover:shadow-sm disabled:cursor-not-allowed
                                   disabled:line-through disabled:opacity-35
                                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        {slotLabel(slot.startIso)}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Closed that day — pick another.
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}

        {step === 'details' && selected ? (
          <form className="space-y-3" onSubmit={submit}>
            <div
              className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              <span>{slotRangeLabel(selected.startIso, selected.endIso)}</span>
              <button type="button" onClick={() => setStep('slot')} className="underline">
                Change
              </button>
            </div>

            {(['name', 'email', 'phone'] as const).map((field) => (
              <label key={field} className="block">
                <span className="text-xs font-medium capitalize">
                  {field === 'phone' ? 'Phone number' : field}
                </span>
                <input
                  required
                  type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
                  value={form[field]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field]: e.target.value }))}
                  placeholder={field === 'phone' ? '0300 1234567' : undefined}
                  className="mt-1 w-full rounded-lg border px-2.5 py-1.5 text-sm
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  style={{ background: 'transparent', borderColor: 'var(--border)' }}
                />
                {failure?.field === field && (
                  <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                    {failure.message}
                  </span>
                )}
              </label>
            ))}

            {failure && !failure.field && (
              <p className="text-[11px] text-red-600 dark:text-red-400">{failure.message}</p>
            )}

            <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
              The agent needs your phone number to confirm — Google never shares one.
            </p>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white
                         transition hover:bg-brand-700 disabled:opacity-50
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {submitting ? 'Booking…' : 'Confirm viewing'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
