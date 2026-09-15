/** Thin, typed wrapper over the Vectara v2 REST API. */

export interface VectaraConfig {
  apiKey: string;
  baseUrl: string;
}

export class VectaraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'VectaraError';
  }
}

export class VectaraClient {
  constructor(private readonly config: VectaraConfig) {}

  private get headers(): Record<string, string> {
    return {
      'x-api-key': this.config.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { allowStatuses = [] as number[] } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await res.text();
    if (!res.ok && !allowStatuses.includes(res.status)) {
      throw new VectaraError(`${method} ${path} -> HTTP ${res.status}`, res.status, text.slice(0, 600));
    }

    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      data = {} as T;
    }
    return { status: res.status, data };
  }
}

/** Build a client from environment variables, failing loudly if unset. */
export function clientFromEnv(): VectaraClient {
  const apiKey = process.env['VECTARA_API_KEY'];
  const baseUrl = process.env['VECTARA_BASE_URL'] ?? 'https://api.vectara.io/v2';
  if (!apiKey) {
    throw new Error('VECTARA_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  return new VectaraClient({ apiKey, baseUrl });
}
