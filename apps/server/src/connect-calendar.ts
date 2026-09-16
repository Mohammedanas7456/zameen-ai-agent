/**
 * One-time connection of the estate agent's Google Calendar.
 *
 * Runs locally and never on the deployed service, which is what keeps the
 * private-Cloud-Run problem away from the estate-agent side entirely: the
 * deployed app only ever receives the resulting refresh token as an env var.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.js';
import { AGENT_SCOPES, authUrl, exchangeCode } from './google/oauth.js';
import { TOKEN_FILE, writeRefreshToken } from './google/tokens.js';

const PORT = 5858;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

/** Serve one request, capture the code, then shut the listener down. */
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const done = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font:16px system-ui;padding:3rem">${message}</body></html>`);
        server.close();
      };

      if (error) {
        done('Connection refused. You can close this tab.');
        reject(new Error(`Google returned an error: ${error}`));
      } else if (!code || state !== expectedState) {
        done('Could not verify that response. You can close this tab.');
        reject(new Error('State mismatch or missing code.'));
      } else {
        done('Calendar connected. You can close this tab and return to the terminal.');
        resolve(code);
      }
    });

    server.on('error', reject);
    server.listen(PORT);
  });
}

async function main(): Promise<void> {
  const { clientId, clientSecret } = config.google;
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    console.error(`Register ${REDIRECT_URI} as an authorised redirect URI on that OAuth client.`);
    process.exit(1);
  }

  const state = randomBytes(16).toString('hex');
  const url = authUrl({
    clientId,
    redirectUri: REDIRECT_URI,
    scopes: AGENT_SCOPES,
    state,
    // Both access_type=offline and prompt=consent, or a repeat authorization
    // silently returns no refresh token at all.
    offline: true,
  });

  console.log('\nOpen this URL and grant calendar access:\n');
  console.log(`  ${url}\n`);
  console.log(`Waiting on ${REDIRECT_URI} ...\n`);

  const code = await waitForCode(state);
  const { refreshToken } = await exchangeCode({ code, clientId, clientSecret, redirectUri: REDIRECT_URI });

  if (!refreshToken) {
    console.error('Google returned no refresh token. This happens when the client was already');
    console.error('authorised and prompt=consent was not sent. Revoke access at');
    console.error('https://myaccount.google.com/permissions and run this again.');
    process.exit(1);
  }

  writeRefreshToken(refreshToken);
  console.log(`Wrote ${TOKEN_FILE} — local development is ready.\n`);
  console.log('For Cloud Run, add this to the deploy command:\n');
  console.log(`  GOOGLE_REFRESH_TOKEN=${refreshToken}\n`);
  console.log('Note: while the OAuth consent screen is in Testing status this token');
  console.log('expires after 7 days. Re-run this command when booking returns a 503.\n');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
