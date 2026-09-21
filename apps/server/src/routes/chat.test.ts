import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// routes/chat.ts reaches config.ts through the modules mocked below, and
// config.ts calls required('VECTARA_API_KEY') at import time.
process.env['VECTARA_API_KEY'] ??= 'test-key';

const createSession = vi.fn();
const searchListings = vi.fn();
const handleUserMessage = vi.fn();

// Mocked outright rather than with importActual: the real modules import
// config.ts, and the routes only need these exports.
vi.mock('../vectara.js', () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  searchListings: (...a: unknown[]) => searchListings(...a),
  UpstreamError: class UpstreamError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));

vi.mock('../chat.js', () => ({
  handleUserMessage: (...a: unknown[]) => handleUserMessage(...a),
}));

const { mountChatRoutes } = await import('./chat.js');
const { UpstreamError } = await import('../vectara.js');
const { MAX_MESSAGE_CHARS } = await import('../limits.js');

async function withServer(
  fn: (base: string, port: number) => Promise<void>,
  opts: { maxTurns?: number } = {},
): Promise<void> {
  const app = express();
  app.use(express.json());
  mountChatRoutes(app, opts);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A promise a test settles by hand, so a turn can be held open without
 *  anything sleeping for real. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const chat = (base: string, body: unknown) => post(base, '/api/chat', body);

beforeEach(() => {
  createSession.mockReset();
  searchListings.mockReset();
  handleUserMessage.mockReset();
});

describe('POST /api/session', () => {
  it('returns the key of the session it minted', async () => {
    createSession.mockResolvedValueOnce('ase_1');
    await withServer(async (base) => {
      const res = await post(base, '/api/session', {});
      expect(res.status).toBe(200);
      expect((await res.json()) as { sessionKey: string }).toEqual({ sessionKey: 'ase_1' });
    });
  });

  it('passes an upstream failure through with its own status', async () => {
    createSession.mockRejectedValueOnce(new UpstreamError('agent is gone', 404));
    await withServer(async (base) => {
      const res = await post(base, '/api/session', {});
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('agent is gone');
    });
  });
});

describe('POST /api/search', () => {
  it('searches on exactly the filters it was given', async () => {
    searchListings.mockResolvedValueOnce([]);
    await withServer(async (base) => {
      const res = await post(base, '/api/search', { filters: { purpose: 'rent' }, query: 'sea facing' });
      expect(res.status).toBe(200);
      expect(searchListings).toHaveBeenCalledWith({ purpose: 'rent' }, 'sea facing');
    });
  });

  it('defaults to no filters and an empty query', async () => {
    searchListings.mockResolvedValueOnce([]);
    await withServer(async (base) => {
      await post(base, '/api/search', {});
      expect(searchListings).toHaveBeenCalledWith({}, '');
    });
  });
});

describe('POST /api/chat', () => {
  it('rejects a request without a session key or a message', async () => {
    await withServer(async (base) => {
      expect((await chat(base, { message: 'hi' })).status).toBe(400);
      expect((await chat(base, { sessionKey: 'sess' })).status).toBe(400);
      expect((await chat(base, { sessionKey: 'sess', message: '   ' })).status).toBe(400);
      expect(handleUserMessage).not.toHaveBeenCalled();
    });
  });

  it('rejects a message longer than the cap', async () => {
    await withServer(async (base) => {
      const res = await chat(base, { sessionKey: 'sess', message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) });
      expect(res.status).toBe(413);
      expect(handleUserMessage).not.toHaveBeenCalled();
    });
  });

  it('refuses a second turn while one is still streaming for the same session', async () => {
    await withServer(async (base) => {
      const gate = deferred();
      const entered = deferred();
      handleUserMessage.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });

      const first = chat(base, { sessionKey: 'sess', message: 'hi' });
      await entered.promise;

      const second = await chat(base, { sessionKey: 'sess', message: 'again' });
      expect(second.status).toBe(409);

      gate.resolve();
      const done = await first;
      expect(done.status).toBe(200);
      expect(await done.text()).toContain('"type":"done"');
    });
  });

  it('refuses a turn once the session has spent its budget', async () => {
    await withServer(
      async (base) => {
        handleUserMessage.mockResolvedValue(undefined);
        const first = await chat(base, { sessionKey: 'sess', message: 'one' });
        expect(first.status).toBe(200);
        await first.text();

        const second = await chat(base, { sessionKey: 'sess', message: 'two' });
        expect(second.status).toBe(429);
        // A fresh session still has its own budget.
        expect((await chat(base, { sessionKey: 'other', message: 'one' })).status).toBe(200);
      },
      { maxTurns: 1 },
    );
  });

  it('reports a session Vectara no longer has as one the browser can replace', async () => {
    await withServer(async (base) => {
      handleUserMessage.mockRejectedValueOnce(new UpstreamError('no such session', 404));
      const res = await chat(base, { sessionKey: 'sess', message: 'hi' });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('"code":"session_expired"');
      expect(body).not.toContain('"type":"done"');
    });
  });

  it('reports any other failure as a plain error frame', async () => {
    await withServer(async (base) => {
      handleUserMessage.mockRejectedValueOnce(new Error('upstream is sulking'));
      const res = await chat(base, { sessionKey: 'sess', message: 'hi' });
      const body = await res.text();
      expect(body).toContain('upstream is sulking');
      expect(body).not.toContain('session_expired');
    });
  });

  it('releases the gate after a turn that threw', async () => {
    await withServer(async (base) => {
      handleUserMessage.mockRejectedValueOnce(new Error('boom'));
      await (await chat(base, { sessionKey: 'sess', message: 'hi' })).text();

      handleUserMessage.mockResolvedValueOnce(undefined);
      const second = await chat(base, { sessionKey: 'sess', message: 'again' });
      expect(second.status).toBe(200);
      await second.text();
    });
  });

  it('releases the gate when the client closes the socket mid-turn', async () => {
    await withServer(async (base, port) => {
      const gate = deferred();
      const entered = deferred();
      // Captured from the call itself, not asserted against a fresh
      // AbortController: what matters is that the route hands the socket's
      // own signal through, and that that signal is the one that fires.
      let capturedSignal: AbortSignal | undefined;
      handleUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
        capturedSignal = args[5] as AbortSignal;
        entered.resolve();
        await gate.promise;
      });

      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      // Destroying our own request is how this test plays the client leaving;
      // the resulting ECONNRESET is the point, not a failure.
      req.on('error', () => {});
      req.end(JSON.stringify({ sessionKey: 'sess', message: 'hi' }));
      await entered.promise;
      req.destroy();

      // The turn ends once Vectara's stream does, however the socket went.
      gate.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(handleUserMessage).toHaveBeenCalledWith(
        'sess',
        'hi',
        expect.any(Function),
        expect.any(Function),
        undefined,
        expect.any(AbortSignal),
      );
      // The route's whole point is to hand upstream calls a signal that
      // actually fires when the socket does — not just any AbortSignal.
      expect(capturedSignal?.aborted).toBe(true);

      handleUserMessage.mockResolvedValueOnce(undefined);
      const second = await chat(base, { sessionKey: 'sess', message: 'again' });
      expect(second.status).toBe(200);
      await second.text();
    });
  });
});
