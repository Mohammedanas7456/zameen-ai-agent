import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_SCOPES,
  BUYER_SCOPES,
  CalendarDisconnectedError,
  GoogleError,
  authUrl,
  exchangeCode,
  fetchUserInfo,
  refreshAccessToken,
} from './oauth.js';

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with one canned response. Returns the spy so the call can be asserted. */
function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number; jsonFn?: () => Promise<unknown> } = {},
) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: init.jsonFn ?? (async () => body),
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('authUrl', () => {
  it('builds a buyer sign-in URL with only the identity scopes', () => {
    const url = new URL(
      authUrl({
        clientId: 'cid',
        redirectUri: 'http://localhost:5173/api/auth/google/callback',
        scopes: BUYER_SCOPES,
        state: 'nonce123',
        offline: false,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('nonce123');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/callback');
  });

  it('omits offline parameters for the buyer flow, which needs no refresh token', () => {
    const url = new URL(authUrl({ clientId: 'c', redirectUri: 'r', scopes: BUYER_SCOPES, state: 's', offline: false }));
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('forces consent on the estate-agent flow, or Google returns no refresh token on a repeat authorization', () => {
    const url = new URL(authUrl({ clientId: 'c', redirectUri: 'r', scopes: AGENT_SCOPES, state: 's', offline: true }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('requests free/busy read access as well as events, which events alone does not grant', () => {
    // Verified against Google's discovery document: freebusy.query accepts
    // calendar, calendar.freebusy, calendar.events.freebusy or
    // calendar.readonly — never calendar.events. A token holding only
    // calendar.events can create the booking but gets 403
    // insufficientPermissions when checking whether the slot is free.
    const url = new URL(authUrl({ clientId: 'c', redirectUri: 'r', scopes: AGENT_SCOPES, state: 's', offline: true }));
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.freebusy');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('keeps the buyer flow free of any calendar scope, so buyers meet no unverified-app warning', () => {
    expect(BUYER_SCOPES.some((s) => s.includes('calendar'))).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('posts form-encoded parameters to the token endpoint', async () => {
    const spy = stubFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 });
    const result = await exchangeCode({ code: 'abc', clientId: 'cid', clientSecret: 'sec', redirectUri: 'uri' });

    expect(result).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3599 });
    const [url, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('abc');
    expect(sent.get('client_secret')).toBe('sec');
  });

  it('reports a null refresh token rather than inventing one', async () => {
    stubFetch({ access_token: 'at', expires_in: 3599 });
    const result = await exchangeCode({ code: 'a', clientId: 'c', clientSecret: 's', redirectUri: 'u' });
    expect(result.refreshToken).toBeNull();
  });

  it('throws GoogleError when Google returns HTTP 200 with a body that fails to parse as JSON', async () => {
    stubFetch(null, {
      ok: true,
      status: 200,
      jsonFn: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const err = await exchangeCode({ code: 'a', clientId: 'c', clientSecret: 's', redirectUri: 'u' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GoogleError);
    expect(err).not.toBeInstanceOf(CalendarDisconnectedError);
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for an access token', async () => {
    const spy = stubFetch({ access_token: 'fresh', expires_in: 3599 });
    const result = await refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's' });

    expect(result).toEqual({ accessToken: 'fresh', expiresIn: 3599 });
    const sent = new URLSearchParams(((spy.mock.calls[0]! as unknown as [string, RequestInit])[1] as RequestInit).body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
  });

  it('raises CalendarDisconnectedError on invalid_grant, which is what a dead token looks like', async () => {
    stubFetch({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { ok: false, status: 400 });
    await expect(refreshAccessToken({ refreshToken: 'dead', clientId: 'c', clientSecret: 's' }))
      .rejects.toBeInstanceOf(CalendarDisconnectedError);
  });

  it('raises a plain GoogleError for other failures, so they are not mistaken for a dead token', async () => {
    stubFetch({ error: 'internal_failure' }, { ok: false, status: 500 });
    const err = await refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CalendarDisconnectedError);
    expect(err.status).toBe(500);
  });

  it('throws GoogleError when Google returns HTTP 200 with valid JSON that omits access_token', async () => {
    stubFetch({ expires_in: 3599 });
    const err = await refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GoogleError);
    expect(err).not.toBeInstanceOf(CalendarDisconnectedError);
  });
});

describe('fetchUserInfo', () => {
  it('reads the name and email from the userinfo endpoint', async () => {
    const spy = stubFetch({ sub: '1', name: 'Asad Khan', email: 'asad@example.com', email_verified: true });
    await expect(fetchUserInfo('at')).resolves.toEqual({ name: 'Asad Khan', email: 'asad@example.com' });

    const [url, init] = spy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at');
  });

  it('falls back to an empty name when Google supplies none', async () => {
    stubFetch({ sub: '1', email: 'asad@example.com' });
    await expect(fetchUserInfo('at')).resolves.toEqual({ name: '', email: 'asad@example.com' });
  });

  it('throws GoogleError when Google returns HTTP 200 with a body that fails to parse as JSON', async () => {
    stubFetch(null, {
      ok: true,
      status: 200,
      jsonFn: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    await expect(fetchUserInfo('at')).rejects.toBeInstanceOf(GoogleError);
  });

  it('tolerates a profile with no email rather than failing the whole sign-in', async () => {
    // Google's granular consent lets a buyer grant `profile` and `openid` while
    // declining `email`, so this is a legitimate 200 — not an error. Rejecting
    // it would fail sign-in with a "try again" message retrying cannot fix,
    // when the booking form asks for an email anyway.
    stubFetch({ sub: '1', name: 'Asad Khan' });
    await expect(fetchUserInfo('at')).resolves.toEqual({ name: 'Asad Khan', email: '' });
  });
});
