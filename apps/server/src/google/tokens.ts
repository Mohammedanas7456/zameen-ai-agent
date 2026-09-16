import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../config.js';
import { CalendarDisconnectedError, refreshAccessToken } from './oauth.js';

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenProvider {
  get(now?: number): Promise<string>;
}

/** Where `npm run connect:calendar` writes the token in development.
 *  Gitignored, alongside `.vectara-state.json`. */
export const TOKEN_FILE = join(ROOT, '.google-token.json');

/**
 * Cache access tokens in memory, refreshing from the refresh token on demand.
 *
 * Credentials arrive through a getter rather than a value so a token written
 * to disk after boot is still picked up, and so tests can swap them.
 */
export function createTokenProvider(creds: () => GoogleCreds): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async get(now = Date.now()): Promise<string> {
      const { clientId, clientSecret, refreshToken } = creds();
      if (!clientId || !clientSecret || !refreshToken) throw new CalendarDisconnectedError();

      // Refresh a minute early so a token can never expire mid-request.
      if (cached && now < cached.expiresAt - 60_000) return cached.token;

      const { accessToken, expiresIn } = await refreshAccessToken({ refreshToken, clientId, clientSecret });
      cached = { token: accessToken, expiresAt: now + expiresIn * 1000 };
      return accessToken;
    },
  };
}

/** Production passes the token as an env var; development reads the file the
 *  connect script wrote. */
export function readRefreshToken(): string {
  if (config.google.refreshToken) return config.google.refreshToken;
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { refresh_token?: string };
    return parsed.refresh_token ?? '';
  } catch {
    return '';
  }
}

export function writeRefreshToken(token: string): void {
  writeFileSync(TOKEN_FILE, `${JSON.stringify({ refresh_token: token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

export function googleCredentials(): GoogleCreds {
  return {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    refreshToken: readRefreshToken(),
  };
}

export function isBookingEnabled(): boolean {
  const { clientId, clientSecret, refreshToken } = googleCredentials();
  return Boolean(clientId && clientSecret && refreshToken);
}

export const tokens = createTokenProvider(googleCredentials);
