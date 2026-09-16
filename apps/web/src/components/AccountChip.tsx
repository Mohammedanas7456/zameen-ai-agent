import { SIGN_IN_URL, type Me } from '../lib/booking.js';

/**
 * Deliberately quiet when signed out: while the OAuth consent screen is in
 * Testing status only listed test users can sign in at all, so entering
 * details by hand is the primary path and the UI must not imply otherwise.
 */
export function AccountChip({ me, onSignOut }: { me: Me | null; onSignOut: () => void }) {
  if (!me) return null;

  if (!me.buyer) {
    return (
      <a
        href={SIGN_IN_URL}
        className="rounded-lg border px-2.5 py-1.5 text-xs font-medium transition hover:shadow-sm
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        style={{ borderColor: 'var(--border)' }}
      >
        Sign in with Google
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="text-right">
        <p className="text-xs font-semibold leading-tight">{me.buyer.name || me.buyer.email}</p>
        <p className="text-[10px] leading-tight" style={{ color: 'var(--muted)' }}>
          {me.buyer.email}
        </p>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded-lg border px-2 py-1 text-[11px] transition hover:shadow-sm
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        style={{ borderColor: 'var(--border)' }}
      >
        Sign out
      </button>
    </div>
  );
}
