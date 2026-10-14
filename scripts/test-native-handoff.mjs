// Native OAuth handoff: system browser finishes Google/Discord, the app webview adopts the session.
//   npm run test:native
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

function verifierPair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-native-'));
process.env.DATA_DIR = DATA;
process.env.SESSION_SECRET = 'native-handoff-test-secret';
process.env.PUBLIC_URL = 'https://chat.example.com';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.DISCORD_CLIENT_ID = 'test-discord-client';
process.env.DISCORD_CLIENT_SECRET = 'test-discord-secret';
process.env.TRUST_PROXY = 'loopback';
process.env.NATIVE_AUTH_SCHEME = 'camchat';

const { createApp } = await import('../server/http.ts');
const { migrate } = await import('../server/db.ts');
const repo = await import('../server/repo.ts');
const { issueNativeHandoff, consumeNativeHandoff } = await import('../server/nativeHandoff.ts');
migrate();

const realFetch = globalThis.fetch.bind(globalThis);
const app = createApp(() => []);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookiesFrom(res) {
  const jar = new Map();
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    const k = kv.slice(0, i);
    const v = decodeURIComponent(kv.slice(i + 1));
    if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
  }
  return jar;
}
function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}
async function get(pathname, jar) {
  const headers = {};
  if (jar && cookieHeader(jar)) headers.cookie = cookieHeader(jar);
  const res = await realFetch(base + pathname, { redirect: 'manual', headers });
  return { res, jar: cookiesFrom(res), loc: res.headers.get('location') };
}
async function post(pathname, body, jar) {
  const headers = { 'content-type': 'application/json', 'x-csrf': '1', origin: 'https://chat.example.com' };
  if (jar && cookieHeader(jar)) headers.cookie = cookieHeader(jar);
  const res = await realFetch(base + pathname, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body) });
  return { res, jar: cookiesFrom(res) };
}

const PAIR = verifierPair();

// --- token store ---
{
  const u = repo.createUser('HandoffUser', null, null, '127.0.0.1');
  const pair = verifierPair();
  const token = issueNativeHandoff(u.id, pair.challenge, 30);
  ok(consumeNativeHandoff(token, pair.verifier) === u.id, 'consume returns the user id');
  ok(consumeNativeHandoff(token, pair.verifier) === null, 'token is single use');
  ok(consumeNativeHandoff('nope', pair.verifier) === null, 'malformed token is rejected');
  const wrong = issueNativeHandoff(u.id, pair.challenge);
  ok(consumeNativeHandoff(wrong, 'not-the-verifier-0123456789') === null, 'wrong verifier is rejected');
  ok(consumeNativeHandoff(wrong, pair.verifier) === null, 'a failed redeem burns the token');
  const expired = issueNativeHandoff(u.id, pair.challenge, 1);
  await sleep(20);
  ok(consumeNativeHandoff(expired, pair.verifier) === null, 'expired token is rejected');

  const livePair = verifierPair();
  const live = issueNativeHandoff(u.id, livePair.challenge);
  const bad = await get('/api/auth/native?token=not-a-real-token&verifier=' + livePair.verifier);
  ok(bad.res.status === 302 && bad.loc.startsWith('/?authError='), 'bad handoff redirects home with an error');
  ok(!bad.jar.has('camchat_sid'), 'bad handoff does not set a session cookie');
  const noVerifier = await get('/api/auth/native?token=' + encodeURIComponent(live));
  ok(noVerifier.loc.startsWith('/?authError='), 'handoff without the verifier is rejected');

  const again = verifierPair();
  const live2 = issueNativeHandoff(u.id, again.challenge);
  const first = await get('/api/auth/native?token=' + encodeURIComponent(live2) + '&verifier=' + encodeURIComponent(again.verifier));
  ok(first.res.status === 302 && first.loc === '/', 'valid handoff redirects home');
  ok(first.jar.has('camchat_sid'), 'valid handoff sets camchat_sid');
  ok(/HttpOnly/i.test(first.res.headers.getSetCookie().find((c) => c.startsWith('camchat_sid')) || ''), 'session cookie is HttpOnly');
  ok(/SameSite=Lax/i.test(first.res.headers.getSetCookie().find((c) => c.startsWith('camchat_sid')) || ''), 'session cookie is SameSite=Lax');
  const me = await get('/api/me', first.jar);
  ok(me.res.status === 200, '/api/me after handoff is 200');
  const meJson = await me.res.json();
  ok(meJson.account?.username === 'HandoffUser', 'handoff session is the right account');
  const replay = await get('/api/auth/native?token=' + encodeURIComponent(live2) + '&verifier=' + encodeURIComponent(again.verifier));
  ok(replay.loc.startsWith('/?authError='), 'replaying a handoff token fails');

  const ghostPair = verifierPair();
  const ghost = issueNativeHandoff(999999, ghostPair.challenge);
  const missing = await get('/api/auth/native?token=' + encodeURIComponent(ghost) + '&verifier=' + encodeURIComponent(ghostPair.verifier));
  ok(missing.loc.includes('Sign-in%20failed') || missing.loc.includes('Sign-in+failed'), 'handoff for a missing user fails');
}

// --- password login still sets the cookie directly (no handoff) ---
{
  const hash = bcrypt.hashSync('password12', 11);
  repo.createUser('PasswordUser', hash, null, '127.0.0.1');
  const login = await post('/api/auth/login', { username: 'PasswordUser', password: 'password12' });
  ok(login.res.status === 200 && login.jar.has('camchat_sid'), 'password login still sets the session cookie');
  const me = await get('/api/me', login.jar);
  const meJson = await me.res.json();
  ok(meJson.account?.username === 'PasswordUser', 'password session survives /api/me');
}

function installProviderMock() {
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'g-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (s.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return new Response(JSON.stringify({ sub: 'google-sub-1', email: 'ada@example.com', given_name: 'Ada' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (s.includes('discord.com/api/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'd-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (s.includes('discord.com/api/users/@me')) {
      return new Response(JSON.stringify({ id: '998877', username: 'ada_discord', global_name: 'AdaDisc' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
}

// --- Google: browser flow unchanged, native flow returns camchat:// ---
{
  const plain = await get('/api/auth/google');
  ok(plain.res.status === 302 && plain.loc.startsWith('https://accounts.google.com/'), 'browser Google start redirects to Google');
  ok(!plain.jar.has('camchat_oauth_nonce'), 'browser Google start does not set a native nonce cookie');
  ok(plain.jar.has('camchat_oauth'), 'browser Google start still sets the oauth state cookie');

  const badNonce = await get('/api/auth/google?client=native&nonce=short');
  ok(!badNonce.jar.has('camchat_oauth_nonce'), 'a short nonce is ignored');

  const started = await get(`/api/auth/google?client=native&nonce=${PAIR.challenge}`);
  ok(started.jar.get('camchat_oauth_nonce') === PAIR.challenge, 'native Google start stores the challenge cookie');
  const state = new URL(started.loc).searchParams.get('state');
  ok(!!state && started.jar.get('camchat_oauth') === state, 'oauth state cookie matches the Google state param');

  installProviderMock();
  const done = await get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, started.jar);
  globalThis.fetch = realFetch;
  ok(done.res.status === 302 && done.loc.startsWith('camchat://auth?'), 'native Google callback redirects to the app scheme');
  const back = new URL(done.loc);
  ok(back.hostname === 'auth' && back.searchParams.get('nonce') === PAIR.challenge, 'callback echoes the challenge, not the verifier');
  const token = back.searchParams.get('token');
  ok(!!token && token.length > 20, 'callback includes a handoff token');
  ok(done.jar.has('camchat_sid'), 'callback also sets a session cookie on the browser response');

  const adopted = await get('/api/auth/native?token=' + encodeURIComponent(token) + '&verifier=' + encodeURIComponent(PAIR.verifier));
  const me = await get('/api/me', adopted.jar);
  const meJson = await me.res.json();
  ok(meJson.account?.username === 'Ada', 'app webview adopts the Google account');

  const browserStart = await get('/api/auth/google');
  installProviderMock();
  const browserDone = await get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(browserStart.jar.get('camchat_oauth'))}`, browserStart.jar);
  globalThis.fetch = realFetch;
  ok(browserDone.loc === '/' && browserDone.jar.has('camchat_sid'), 'browser Google callback still redirects home with a session');
  const browserMe = await (await get('/api/me', browserDone.jar)).res.json();
  ok(browserMe.account?.username === 'Ada', 'browser Google callback signs in the same account');

  const mismatch = await get(`/api/auth/google?client=native&nonce=${PAIR.challenge}`);
  const bad = await get('/api/auth/google/callback?code=abc&state=nope', mismatch.jar);
  ok(bad.loc.startsWith('camchat://auth?') && new URL(bad.loc).searchParams.get('error') && !new URL(bad.loc).searchParams.get('token'), 'expired native Google state returns an error to the app');
}

// --- Discord uses the same handoff ---
{
  const discordPair = verifierPair();
  const started = await get(`/api/auth/discord?client=native&nonce=${discordPair.challenge}`);
  ok(started.res.status === 302 && started.loc.startsWith('https://discord.com/'), 'native Discord start redirects to Discord');
  ok(started.jar.get('camchat_oauth_nonce') === discordPair.challenge, 'native Discord start stores the challenge');
  installProviderMock();
  const done = await get(`/api/auth/discord/callback?code=abc&state=${encodeURIComponent(started.jar.get('camchat_oauth'))}`, started.jar);
  globalThis.fetch = realFetch;
  const token = new URL(done.loc).searchParams.get('token');
  ok(done.loc.startsWith('camchat://auth?') && !!token, 'native Discord callback redirects to the app scheme');
  const adopted = await get('/api/auth/native?token=' + encodeURIComponent(token) + '&verifier=' + encodeURIComponent(discordPair.verifier));
  const meJson = await (await get('/api/me', adopted.jar)).res.json();
  ok(meJson.account?.username === 'AdaDisc', 'app webview adopts the Discord account');
}

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
