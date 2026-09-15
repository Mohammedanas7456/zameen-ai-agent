import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Workspace scripts run with their own package as cwd, so load the root .env.
loadEnv({ path: join(ROOT, '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  apiKey: required('VECTARA_API_KEY'),
  baseUrl: process.env['VECTARA_BASE_URL'] ?? 'https://api.vectara.io/v2',
  corpusKey: process.env['VECTARA_CORPUS_KEY'] ?? 'zameen-karachi-properties',
  agentKey: process.env['VECTARA_AGENT_KEY'] ?? 'zameen_property_assistant',
  port: Number.parseInt(process.env['PORT'] ?? '8787', 10),
  /** Vite dev server origins allowed to call this API. */
  corsOrigins: (process.env['CORS_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
} as const;
