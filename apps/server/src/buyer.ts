import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BuyerDetails } from '@zameen/shared';
import { sanitizeText } from './text.js';

export { sanitizeText };

export const BUYER_COOKIE = 'zameen_buyer';
export const STATE_COOKIE = 'zameen_oauth_state';

export interface StoredBuyer extends BuyerDetails {
  via: 'google' | 'manual';
}

export type ValidationResult =
  | { ok: true; buyer: BuyerDetails }
  | { ok: false; field: 'name' | 'email' | 'phone'; message: string };

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Normalise a phone number to E.164, or reject it.
 *
 * Pakistani local form (leading 0) becomes +92. A number that already carries a
 * country code is kept as-is, because overseas Pakistanis are a real share of
 * Zameen's buyers and must not be locked out.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (/^0\d{10}$/.test(cleaned)) return `+92${cleaned.slice(1)}`;
  if (/^92\d{9,11}$/.test(cleaned)) return `+${cleaned}`;
  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
  return null;
}

export function validateBuyer(input: unknown): ValidationResult {
  const raw = (input ?? {}) as Record<string, unknown>;

  const name = sanitizeText(raw['name'], 80);
  if (name.length < 2) {
    return { ok: false, field: 'name', message: 'Please enter your full name.' };
  }

  const email = sanitizeText(raw['email'], 200).toLowerCase();
  if (!isValidEmail(email)) {
    return { ok: false, field: 'email', message: 'Please enter a valid email address.' };
  }

  const phone = normalizePhone(raw['phone']);
  if (!phone) {
    return {
      ok: false,
      field: 'phone',
      message: 'Please enter a valid phone number, for example 0300 1234567.',
    };
  }

  return { ok: true, buyer: { name, email, phone } };
}

/** `base64url(json).base64url(hmac)`. No JWT library, no claims, no expiry
 *  beyond the cookie's own Max-Age. */
export function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));

  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Express has res.cookie() but no reader without cookie-parser, and one small
 *  loop is cheaper than the dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }

  return out;
}
