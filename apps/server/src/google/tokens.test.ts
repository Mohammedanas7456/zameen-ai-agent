import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarDisconnectedError } from './oauth.js';
import { createTokenProvider, type GoogleCreds } from './tokens.js';

afterEach(() => vi.unstubAllGlobals());

const CREDS: GoogleCreds = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' };

/** One canned token response per call, so call counts are meaningful. */
function stubRefresh(token = 'at', expiresIn = 3600) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('createTokenProvider', () => {
  it('fetches an access token on first use', async () => {
    const spy = stubRefresh('first');
    const provider = createTokenProvider(() => CREDS);
    await expect(provider.get(0)).resolves.toBe('first');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves a cached token without touching the network', async () => {
    const spy = stubRefresh('cached');
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await expect(provider.get(60_000)).resolves.toBe('cached');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the token has expired', async () => {
    const spy = stubRefresh('t', 3600);
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await provider.get(3_600_001);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refreshes inside the 60-second skew, so a token never expires mid-request', async () => {
    const spy = stubRefresh('t', 3600);
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await provider.get(3_600_000 - 30_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reports a disconnected calendar when any credential is missing, without calling Google', async () => {
    const spy = stubRefresh();
    const provider = createTokenProvider(() => ({ ...CREDS, refreshToken: '' }));
    await expect(provider.get(0)).rejects.toBeInstanceOf(CalendarDisconnectedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-reads credentials each time, so a token written after boot is picked up', async () => {
    stubRefresh('late');
    let creds: GoogleCreds = { ...CREDS, refreshToken: '' };
    const provider = createTokenProvider(() => creds);
    await expect(provider.get(0)).rejects.toBeInstanceOf(CalendarDisconnectedError);
    creds = CREDS;
    await expect(provider.get(0)).resolves.toBe('late');
  });
});
