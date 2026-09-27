import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const URL_ = process.env.AGNC_URL ?? 'https://agnc.wakecap.ai/mcp';
const PORT = 4318;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const STORE = join(OUT, 'oauth.json');

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };
const load = (): Saved => (existsSync(STORE) ? (JSON.parse(readFileSync(STORE, 'utf8')) as Saved) : {});
const save = (patch: Saved) =>
  writeFileSync(STORE, JSON.stringify({ ...load(), ...patch }, null, 2), { mode: 0o600 });

let verifier = '';
const state = Math.random().toString(36).slice(2);
const provider: OAuthClientProvider = {
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata() {
    return {
      client_name: 'Orchestrator (spike S4)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  state: () => state,
  clientInformation: () => load().client,
  saveClientInformation: (client) => save({ client }),
  tokens: () => load().tokens,
  saveTokens: (tokens) => save({ tokens }),
  redirectToAuthorization: (url) => {
    console.log('\nAuthorise here:\n', url.toString(), '\n');
    execFile('open', [url.toString()], () => {});
  },
  saveCodeVerifier: (v) => {
    verifier = v;
  },
  codeVerifier: () => verifier,
};

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      const code = u.searchParams.get('code');
      const got = u.searchParams.get('state');
      res.end(code ? 'S4: authorised. You can close this tab.' : 'S4: missing code');
      if (!code) return;
      server.close();
      if (got !== state) reject(new Error(`state mismatch: ${got}`));
      else resolve(code);
    });
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for the OAuth callback'));
    }, 180_000).unref();
  });
}

/** Keys and value types only — never values. */
function shape(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 3 ? 'array' : [shape(v[0], depth + 1), `…${v.length} items`];
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, shape(val, depth + 1)]),
    );
  }
  return typeof v;
}

async function connect(): Promise<Client> {
  const make = () => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_), { authProvider: provider });
    return { transport, client: new Client({ name: 'orc-spike-s4', version: '0.0.0' }) };
  };
  const first = make();
  try {
    await first.client.connect(first.transport);
    // AGNC answers an unauthenticated `initialize` with 200, so the 401 can only come on the first real request.
    await first.client.listTools();
    return first.client;
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    const code = await waitForCode();
    await first.transport.finishAuth(code);
    const second = make();
    await second.client.connect(second.transport);
    return second.client;
  }
}

// callTool's result type also includes the legacy `{ toolResult }` shape, so take a plain record.
const textOf = (r: Record<string, unknown>): unknown => {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const content = r.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const t0 = Date.now();
const client = await connect();
const tools = await client.listTools();
console.log(
  'tools:',
  tools.tools.map((t) => t.name),
);

const auth = await client.callTool({ name: 'agnc_auth_status', arguments: {} });
console.log('agnc_auth_status shape:', JSON.stringify(shape(textOf(auth)), null, 2));

const list = await client.callTool({ name: 'agnc_list_sessions', arguments: { scope: 'mine', limit: 5 } });
const listed = textOf(list);
console.log('agnc_list_sessions shape:', JSON.stringify(shape(listed), null, 2));

const first = (Array.isArray(listed) ? listed[0] : (listed as { sessions?: unknown[] })?.sessions?.[0]) as
  | { id?: string; sessionId?: string }
  | undefined;
const sessionId = first?.id ?? first?.sessionId;
if (sessionId) {
  for (const [name, args] of [
    ['agnc_get_session', { sessionId }],
    ['agnc_list_messages', { sessionId, limit: 3 }],
    ['agnc_list_events', { sessionId, limit: 3 }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    console.log(`${name} shape:`, JSON.stringify(shape(textOf(r)), null, 2));
  }
} else {
  console.log('no sessions of mine; detail shapes not captured');
}
console.log('tokens expire_in:', load().tokens?.expires_in ?? 'unknown', 'ms total:', Date.now() - t0);
await client.close();
