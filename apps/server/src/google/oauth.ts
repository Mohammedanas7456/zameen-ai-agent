const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Identity only. These are non-sensitive, so buyers never meet the
 *  "Google hasn't verified this app" screen. */
export const BUYER_SCOPES = ['openid', 'email', 'profile'];

/** The estate agent's one-time connection. `calendar.events` is a sensitive
 *  scope, which is why only one person ever runs this flow. */
export const AGENT_SCOPES = [
  'openid',
  'email',
  // Both are needed, and neither implies the other. Google's own discovery
  // document lists `calendar.events` for events.insert but NOT for
  // freebusy.query, which accepts only calendar, calendar.freebusy,
  // calendar.events.freebusy or calendar.readonly. Requesting events alone
  // mints a token that can create the booking but cannot check whether the
  // slot is free — a 403 insufficientPermissions that no mocked test can
  // catch, because it only appears against a real Google token.
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  // Only needed once GOOGLE_SHEET_ID is set; requested unconditionally so an
  // agent who configures a sheet later doesn't need to reconnect.
  'https://www.googleapis.com/auth/spreadsheets',
];

/** The refresh token is gone — revoked, or expired after 7 days because the
 *  OAuth consent screen is still in Testing status. Distinct from a transient
 *  Google failure because the fix is different: reconnect, don't retry. */
export class CalendarDisconnectedError extends Error {
  constructor(message = 'The estate agent calendar is not connected.') {
    super(message);
    this.name = 'CalendarDisconnectedError';
  }
}

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GoogleError';
  }
}

export function authUrl(o: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  offline: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    state: o.state,
  });

  // Without BOTH of these, a *repeat* authorization of an already-approved
  // client returns no refresh_token at all and the connect script silently
  // produces nothing usable.
  if (o.offline) {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    if (typeof data['access_token'] !== 'string' || data['access_token'] === '') {
      throw new GoogleError('Google returned a token response with no access_token', 502);
    }
    return data;
  }

  if (data['error'] === 'invalid_grant') throw new CalendarDisconnectedError();
  throw new GoogleError(`Google token request failed: ${String(data['error'] ?? res.status)}`, res.status);
}

export async function exchangeCode(o: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
    }),
  );

  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : null,
    expiresIn: Number(data['expires_in'] ?? 0),
  };
}

export async function refreshAccessToken(o: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: o.clientId,
      client_secret: o.clientSecret,
    }),
  );

  return {
    accessToken: String(data['access_token'] ?? ''),
    expiresIn: Number(data['expires_in'] ?? 0),
  };
}

/**
 * Read the signed-in buyer's profile.
 *
 * The userinfo endpoint is used rather than decoding the id_token: the token
 * came straight from Google over TLS, so there is no signature to verify and
 * no JWT library to add.
 */
export async function fetchUserInfo(accessToken: string): Promise<{ name: string; email: string }> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new GoogleError(`Could not read the Google profile (HTTP ${res.status})`, res.status);

  // An unreadable body is a real failure and becomes a GoogleError, so callers
  // catching that type still see it rather than a raw SyntaxError.
  const data = (await res.json().catch(() => {
    throw new GoogleError('Google returned an unreadable profile response', 502);
  })) as Record<string, unknown>;

  // A *missing email* is not a failure, though. Google's granular consent lets
  // a buyer grant `profile` and `openid` while declining `email`, so a valid
  // 200 can legitimately omit it — and rejecting that would fail the whole
  // sign-in with a "try again" message that retrying cannot fix. Degrade
  // instead: the booking form asks for an email regardless, which is the same
  // path an unauthenticated buyer already takes.
  return {
    name: typeof data['name'] === 'string' ? data['name'] : '',
    email: typeof data['email'] === 'string' ? data['email'] : '',
  };
}
