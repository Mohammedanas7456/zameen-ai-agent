import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountWebClient } from './static.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // A stand-in for apps/web/dist, so the test never depends on a prior build.
  const distDir = await mkdtemp(join(tmpdir(), 'zameen-dist-'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Zameen</title>');
  await mkdir(join(distDir, 'assets'));
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("app");');

  const app = express();
  // Mounted before the client, exactly as index.ts orders them.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  mountWebClient(app, distDir);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mountWebClient', () => {
  it('serves the SPA shell for a deep link so client-side routing works', async () => {
    const res = await fetch(`${baseUrl}/listing/123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Zameen</title>');
  });

  it('serves the SPA shell at the root', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Zameen</title>');
  });

  it('serves a built asset with its own content type', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('does not shadow an API route mounted before it', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('leaves an unknown /api path a 404 rather than answering it with the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>Zameen</title>');
  });

  it('ignores non-GET requests so a bad POST never receives the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/api/search`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>Zameen</title>');
  });
});
