import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// config.ts calls required('VECTARA_API_KEY') at import time and reads every
// Google value once, so the environment must be set before it is loaded.
// Static imports hoist above assignments, hence the dynamic imports below.
process.env['VECTARA_API_KEY'] ??= 'test-key';
process.env['GOOGLE_CLIENT_ID'] = 'test-client-id';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-secret';

const { config } = await import('../config.js');
const { BUYER_COOKIE, sign } = await import('../buyer.js');
const { mountAuthRoutes } = await import('./auth.js');
type StoredBuyer = import('../buyer.js').StoredBuyer;

afterEach(() => vi.unstubAllGlobals());

/** Run one request against a real server on an ephemeral port. */
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  mountAuthRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const BUYER: StoredBuyer = {
  name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567', via: 'google',
};
const cookieFor = (b: StoredBuyer) => `${BUYER_COOKIE}=${encodeURIComponent(sign(b, config.sessionSecret))}`;

// Node's global fetch types (undici-types, not the DOM lib) type
// Response#json() as Promise<unknown>, so reading a field back out needs a cast.
const meBuyer = async (res: Response): Promise<StoredBuyer | null> =>
  ((await res.json()) as { buyer: StoredBuyer | null }).buyer;

// Import GoogleError for tests that need it
type GoogleError = import('../google/oauth.js').GoogleError;

describe('GET /api/me', () => {
  it('reports no buyer when there is no cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`);
      expect(res.status).toBe(200);
      expect(await meBuyer(res)).toBeNull();
    });
  });

  it('returns the buyer from a valid cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`, { headers: { Cookie: cookieFor(BUYER) } });
      expect(await meBuyer(res)).toEqual(BUYER);
    });
  });

  it('ignores a cookie whose signature does not check out', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`, { headers: { Cookie: `${BUYER_COOKIE}=forged.value` } });
      expect(await meBuyer(res)).toBeNull();
    });
  });
});

describe('GET /api/auth/google', () => {
  it('redirects to Google and remembers the state nonce in a cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
      expect(res.status).toBe(302);

      const target = new URL(res.headers.get('location')!);
      expect(target.origin).toBe('https://accounts.google.com');
      expect(target.searchParams.get('scope')).toBe('openid email profile');
      const state = target.searchParams.get('state')!;
      expect(state).toMatch(/^[a-f0-9]{32}$/);
      expect(res.headers.get('set-cookie')).toContain('zameen_oauth_state=');
    });
  });

  it('requests no offline access, so the buyer flow stays online-only', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
      const target = new URL(res.headers.get('location')!);
      expect(target.searchParams.has('access_type')).toBe(false);
      expect(target.searchParams.has('prompt')).toBe(false);
    });
  });
});

describe('GET /api/auth/google/callback', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/google/callback?code=x&state=attacker`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    });
  });

  it('signs the buyer in and keeps a phone number they had already given', async () => {
    // Captured before stubbing: the test's own request to the local server
    // must not be intercepted by the stub meant for Google's endpoints.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.includes('userinfo')
              ? { name: 'Asad Khan', email: 'asad@example.com' }
              : { access_token: 'at', expires_in: 3599 },
          text: async (): Promise<string> => '',
        };
      }),
    );

    await withServer(async (base) => {
      const nonce = 'a'.repeat(32);
      const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;
      const prior = cookieFor({ ...BUYER, name: 'Old Name', via: 'manual' });

      const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=${nonce}`, {
        redirect: 'manual',
        headers: { Cookie: `${stateCookie}; ${prior}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      const setCookies = res.headers.getSetCookie().join('\n');
      const value = /zameen_buyer=([^;]+)/.exec(setCookies)![1]!;
      const body = JSON.parse(
        Buffer.from(decodeURIComponent(value).split('.')[0]!, 'base64url').toString(),
      );
      // The Google profile wins for name and email; the phone survives, because
      // Google never supplies one.
      expect(body).toMatchObject({
        name: 'Asad Khan',
        email: 'asad@example.com',
        phone: '+923001234567',
        via: 'google',
      });
    });
  });

  it('sets HttpOnly, SameSite=Lax and a 30-day Max-Age on the buyer cookie', async () => {
    // Captured before stubbing: the test's own request to the local server
    // must not be intercepted by the stub meant for Google's endpoints.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.includes('userinfo')
              ? { name: 'Asad Khan', email: 'asad@example.com' }
              : { access_token: 'at', expires_in: 3599 },
          text: async (): Promise<string> => '',
        };
      }),
    );

    await withServer(async (base) => {
      const nonce = 'd'.repeat(32);
      const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;

      const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=${nonce}`, {
        redirect: 'manual',
        headers: { Cookie: stateCookie },
      });

      expect(res.status).toBe(302);
      const buyerCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${BUYER_COOKIE}=`));
      // These are load-bearing per the spec: SameSite=Strict would withhold
      // the cookie on this very top-level redirect and silently break sign-in.
      expect(buyerCookie).toContain('HttpOnly');
      expect(buyerCookie).toContain('SameSite=Lax');
      expect(buyerCookie).toContain('Max-Age=2592000');
    });
  });

  it('returns 400 when the authorization code is expired or already used', async () => {
    const realFetch = globalThis.fetch;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        // Google turns a reused or expired authorization code into
        // invalid_grant at the token endpoint, which postToken maps to
        // CalendarDisconnectedError.
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_grant' }),
            text: async (): Promise<string> => '',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at', expires_in: 3599 }),
          text: async (): Promise<string> => '',
        };
      }),
    );

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const nonce = 'e'.repeat(32);
        const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;

        const res = await fetch(`${base}/api/auth/google/callback?code=expired&state=${nonce}`, {
          redirect: 'manual',
          headers: { Cookie: stateCookie },
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Your sign-in link expired or was already used. Please try signing in again.');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns 502 when a GoogleError occurs during token exchange', async () => {
    const realFetch = globalThis.fetch;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        // Simulate a Google token endpoint failure that produces a GoogleError
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'unauthorized_client' }),
            text: async (): Promise<string> => '',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at', expires_in: 3599 }),
          text: async (): Promise<string> => '',
        };
      }),
    );

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const nonce = 'b'.repeat(32);
        const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;

        const res = await fetch(`${base}/api/auth/google/callback?code=xyz&state=${nonce}`, {
          redirect: 'manual',
          headers: { Cookie: stateCookie },
        });

        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Google sign-in failed. Please try again.');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns 500 when a non-GoogleError is thrown in the callback', async () => {
    const realFetch = globalThis.fetch;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        // Reject with a plain Error, not a GoogleError
        throw new Error('Network timeout');
      }),
    );

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const nonce = 'c'.repeat(32);
        const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;

        const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=${nonce}`, {
          redirect: 'manual',
          headers: { Cookie: stateCookie },
        });

        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Sign-in could not be completed.');
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the buyer cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookieFor(BUYER) } });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/zameen_buyer=;/);
    });
  });
});
