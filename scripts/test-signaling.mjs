// End-to-end protocol test against a running server: node scripts/test-signaling.mjs [url]
// Three accounts (email required). An extra socket with no session checks that nickname login is rejected.
// Each run uses a random documentation IP via CF-Connecting-IP (trusted from loopback) so
// per-IP limits don't carry over between runs.
import { io } from 'socket.io-client';

const URL = process.argv[2] || process.env.URL || 'http://localhost:3000';
let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const FAKE_IP = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const connect = (cookie = '') => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], forceNew: true, extraHeaders: { 'cf-connecting-ip': FAKE_IP, ...(cookie ? { cookie } : {}) } }); s.once('connect', () => res(s)); s.once('connect_error', rej); });
const emit = (s, ev, ...args) => new Promise((res) => s.emit(ev, ...args, res));
const once = (s, ev, pred = () => true, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36).slice(-4);

async function register(username) {
  const capR = await fetch(`${URL}/api/auth/captcha`, { headers: { 'cf-connecting-ip': FAKE_IP } });
  const cap = await capR.json();
  const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  if (!m) throw new Error('captcha missing: ' + JSON.stringify(cap));
  const r = await fetch(`${URL}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': '1', 'cf-connecting-ip': FAKE_IP },
    body: JSON.stringify({
      username, password: `pw-${tag}-${Math.random().toString(36).slice(2)}`,
      email: `${username.toLowerCase()}@example.com`,
      captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]),
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`register ${username}: ${j.error}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const aliceCookie = await register(`Alice_${tag}`);
const bobCookie = await register(`Bob_${tag}`);
const carolCookie = await register(`Carol_${tag}`);
let dupStatus = 0;
{
  const capR = await fetch(`${URL}/api/auth/captcha`, { headers: { 'cf-connecting-ip': FAKE_IP } });
  const cap = await capR.json();
  const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  const dup = await fetch(`${URL}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': '1', 'cf-connecting-ip': FAKE_IP },
    body: JSON.stringify({ username: `alice_${tag}`, password: `pw-${tag}-duplicate1`, email: `dup.${tag}@example.com`, captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]) }),
  });
  dupStatus = dup.status;
}
const a = await connect(aliceCookie), b = await connect(bobCookie), c = await connect(carolCookie), outsider = await connect();
try {
  ok(dupStatus === 409, 'rejects duplicate username (case-insensitive)');
  ok(!(await emit(outsider, 'login', { nick: '<script>' })).ok, 'rejects nickname login with HTML chars');
  ok(!(await emit(outsider, 'login', { nick: 'x' })).ok, 'rejects nickname login when there is no account');
  const la = await emit(a, 'login', {});
  ok(la.ok && la.user.nick === `Alice_${tag}` && la.user.registered && la.user.email === undefined, 'client A logs in without publishing email');
  const lb = await emit(b, 'login', {});
  ok(lb.ok && lb.user.nick === `Bob_${tag}`, 'client B logs in');
  const lc = await emit(c, 'login', {});
  ok(lc.ok && lc.user.nick === `Carol_${tag}`, 'client C logs in');
  ok(!(await emit(c, 'chat:send', { text: 'hi' })).ok, 'chat rejected when not in a room');

  // --- rooms ---
  const list = await emit(a, 'rooms:list');
  ok(list.ok && list.rooms.some((r) => r.id === 'lobby'), 'room list contains Lobby');
  const cr = await emit(a, 'room:create', { name: `Test Room ${tag}`, topic: 'signaling test' });
  ok(cr.ok, `A creates room (${cr.roomId})`);
  const roomId = cr.roomId;

  const roomsUpdate = once(c, 'rooms', (rs) => rs.find((r) => r.id === roomId)?.users === 2, 4000);
  const ja = await emit(a, 'room:join', { roomId });
  ok(ja.ok && ja.room.ownerNick === `Alice_${tag}`, 'A joins and is owner');
  const joinedSeen = once(a, 'user:joined', (u) => u.nick === `Bob_${tag}`);
  const jb = await emit(b, 'room:join', { roomId });
  ok(jb.ok && jb.room.users.length === 2, 'B joins and sees 2 users');
  ok(!!(await joinedSeen), 'A receives user:joined for B');
  ok(jb.room.history.some((m) => m.kind === 'system' && m.text.includes('joined')), 'join notice in history');
  ok(!!(await roomsUpdate), 'lobby client C gets live user count = 2');

  // --- chat ---
  const bGets = once(b, 'chat:message', (m) => m.kind === 'chat');
  ok((await emit(a, 'chat:send', { text: '  hello <b>bob</b>  ' })).ok, 'A sends chat');
  const m = await bGets;
  ok(m.from === `Alice_${tag}` && m.text === 'hello <b>bob</b>' && typeof m.ts === 'number', 'B receives chat with timestamp (text trimmed, raw - escaped at render)');
  const aGets = once(a, 'chat:message', (m) => m.kind === 'chat' && m.from === `Bob_${tag}`);
  await emit(b, 'chat:send', { text: 'hey alice' });
  ok((await aGets).text === 'hey alice', 'A receives chat from B');
  ok(!(await emit(a, 'chat:send', { text: 'x'.repeat(1200) })).ok, 'rejects over-long message');

  // --- media state ---
  const upd = once(b, 'user:updated', (u) => u.id === a.id && u.cam && u.mic);
  ok((await emit(a, 'media:state', { cam: true, mic: true })).ok, 'A sets cam+mic on');
  ok(!!(await upd), 'B sees A on cam/mic');

  // --- WebRTC signaling relay ---
  const offerAtB = once(b, 'rtc:signal', (p) => p.data.type === 'description' && p.data.description.type === 'offer');
  a.emit('rtc:signal', { to: b.id, data: { type: 'description', description: { type: 'offer', sdp: 'v=0 fake-offer' } } });
  const off = await offerAtB;
  ok(off.from === a.id && off.data.description.sdp === 'v=0 fake-offer', 'offer relayed A -> B with correct from');

  const answerAtA = once(a, 'rtc:signal', (p) => p.data.type === 'description' && p.data.description.type === 'answer');
  b.emit('rtc:signal', { to: a.id, data: { type: 'description', description: { type: 'answer', sdp: 'v=0 fake-answer' } } });
  ok((await answerAtA).from === b.id, 'answer relayed B -> A');

  const iceAtB = once(b, 'rtc:signal', (p) => p.data.type === 'candidate');
  const iceAtA = once(a, 'rtc:signal', (p) => p.data.type === 'candidate');
  a.emit('rtc:signal', { to: b.id, data: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
  b.emit('rtc:signal', { to: a.id, data: { type: 'candidate', candidate: { candidate: 'candidate:2 1 udp 1 5.6.7.8 5001 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
  ok((await iceAtB).data.candidate.sdpMid === '0', 'ICE candidate relayed A -> B');
  ok((await iceAtA).from === b.id, 'ICE candidate relayed B -> A');

  // signaling to someone NOT in the room must be dropped
  let leaked = false;
  const leakH = () => { leaked = true; };
  c.on('rtc:signal', leakH);
  a.emit('rtc:signal', { to: c.id, data: { type: 'candidate', candidate: {} } });
  await sleep(400);
  c.off('rtc:signal', leakH);
  ok(!leaked, 'signal to user outside the room is not relayed');

  // --- private message ---
  const pmAtC = once(c, 'pm');
  const pm = await emit(a, 'pm:send', { toId: c.id, text: 'psst' });
  ok(pm.ok && (await pmAtC).text === 'psst', 'private message A -> C');

  // --- kick (owner only) ---
  ok(!(await emit(b, 'room:kick', { userId: a.id })).ok, 'non-owner cannot kick');
  const kicked = once(b, 'room:kicked');
  const leftAtA = once(a, 'user:left', (p) => p.id === b.id);
  ok((await emit(a, 'room:kick', { userId: b.id })).ok, 'owner kicks B');
  ok((await kicked).by === `Alice_${tag}`, 'B notified of kick');
  ok(!!(await leftAtA), 'A sees B leave');
  ok(!(await emit(b, 'room:join', { roomId })).ok, 'kicked user cannot immediately rejoin');

  // --- rate limit ---
  ok((await emit(c, 'room:join', { roomId: 'lobby' })).ok, 'C joins Lobby');
  const results = [];
  for (let i = 0; i < 10; i++) results.push(emit(c, 'chat:send', { text: `spam ${i}` }));
  const r = await Promise.all(results);
  const rejected = r.filter((x) => !x.ok).length;
  ok(rejected >= 4, `rate limiter rejects burst (${rejected}/10 rejected)`);
  await emit(a, 'room:delete'); // cleanup: Alice's room is persistent because she is registered
} catch (e) {
  failed++;
  console.log('FAIL  exception:', e.message);
} finally {
  a.close(); b.close(); c.close(); outsider.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
