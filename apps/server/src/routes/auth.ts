import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  BUYER_COOKIE,
  STATE_COOKIE,
  parseCookies,
  sign,
  verify,
  type StoredBuyer,
} from '../buyer.js';
import { config } from '../config.js';
import { BUYER_SCOPES, authUrl, exchangeCode, fetchUserInfo, GoogleError } from '../google/oauth.js';
import { isBookingEnabled } from '../google/tokens.js';

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

export function buyerRedirectUri(): string {
  return `${config.publicBaseUrl}/api/auth/google/callback`;
}

export function buyerFromRequest(req: Request): StoredBuyer | null {
  const token = parseCookies(req.headers.cookie)[BUYER_COOKIE];
  return verify<StoredBuyer>(token, config.sessionSecret);
}

export function setBuyerCookie(res: Response, buyer: StoredBuyer): void {
  res.cookie(BUYER_COOKIE, sign(buyer, config.sessionSecret), {
    httpOnly: true,
    // Must stay 'lax'. 'strict' withholds the cookie on the top-level redirect
    // back from Google, so the buyer would land signed out immediately.
    sameSite: 'lax',
    secure: config.publicBaseUrl.startsWith('https://'),
    path: '/',
    maxAge: THIRTY_DAYS_MS,
  });
}

export function mountAuthRoutes(app: Express): void {
  app.get('/api/me', (req, res) => {
    res.json({ buyer: buyerFromRequest(req), bookingEnabled: isBookingEnabled() });
  });

  app.get('/api/auth/google', (_req, res) => {
    if (!config.google.clientId) {
      res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
      return;
    }

    const nonce = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, sign({ n: nonce }, config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicBaseUrl.startsWith('https://'),
      path: '/',
      maxAge: 600_000,
    });

    res.redirect(
      authUrl({
        clientId: config.google.clientId,
        redirectUri: buyerRedirectUri(),
        scopes: BUYER_SCOPES,
        state: nonce,
        // The buyer flow needs no refresh token, so it stays online-only.
        offline: false,
      }),
    );
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const stored = verify<{ n: string }>(parseCookies(req.headers.cookie)[STATE_COOKIE], config.sessionSecret);

    res.clearCookie(STATE_COOKIE, { path: '/' });

    if (!code || !state || !stored || stored.n !== state) {
      res.status(400).json({ error: 'Sign-in could not be verified. Please try again.' });
      return;
    }

    try {
      const { accessToken } = await exchangeCode({
        code,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: buyerRedirectUri(),
      });
      const profile = await fetchUserInfo(accessToken);

      // Google never returns a phone number, so carry over anything the buyer
      // has already given us rather than wiping it on sign-in.
      const existing = buyerFromRequest(req);
      setBuyerCookie(res, {
        name: profile.name || existing?.name || '',
        email: profile.email || existing?.email || '',
        phone: existing?.phone ?? '',
        via: 'google',
      });
      res.redirect('/');
    } catch (err) {
      console.error('OAuth callback failed:', err);
      if (err instanceof GoogleError) {
        res.status(502).json({ error: 'Google sign-in failed. Please try again.' });
      } else {
        res.status(500).json({ error: 'Sign-in could not be completed.' });
      }
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(BUYER_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
