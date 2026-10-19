// Cross-checks bridge-kit/webhook-verify.lua against Node's HMAC. LUA=/path/to/lua5.4 (skips when no Lua is found).
import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process'; import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const LUA = process.env.LUA || ['/workspace/zn-test/lua-5.4.6/src/lua', '/usr/bin/lua5.4', '/usr/bin/lua'].find((f) => fs.existsSync(f));
if (!LUA) { console.log('SKIP  no Lua 5.4 found'); process.exit(0); }
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge-kit'));
let bad = 0;
for (const [key, body] of [['whsec_abc', '{"a":1}'], ['k'.repeat(100), 'x'.repeat(1000)], ['whsec_' + crypto.randomBytes(24).toString('base64url'), JSON.stringify({ t: 'héllo ✅', n: [1, 2] })], ['', '']]) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'sha256=' + crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
  fs.writeFileSync('/tmp/lt.json', JSON.stringify({ key, body, ts, sig }));
  const lua = `local v = dofile("webhook-verify.lua"); local f = io.open("/tmp/lt.key","rb"); local k = f:read("a"); f:close(); f = io.open("/tmp/lt.body","rb"); local b = f:read("a"); f:close()
print(v.verify(k, "${ts}", b, "${sig}"), v.verify(k, "${ts}", b .. "x", "${sig}"), v.verify(k, "1", b, "${sig}"))`;
  fs.writeFileSync('/tmp/lt.key', key); fs.writeFileSync('/tmp/lt.body', body);
  const out = execFileSync(LUA, ['-e', lua]).toString().trim();
  const good = out === 'true\tfalse\tfalse'; console.log(`${good ? 'PASS' : 'FAIL'}  lua verify (key ${key.length}, body ${body.length}): ${out.replace(/\t/g, ' ')}`); if (!good) bad++;
}
const sha = execFileSync(LUA, ['-e', 'local v=dofile("webhook-verify.lua"); print(v.tohex(v.sha256("abc")))']).toString().trim();
const shaOk = sha === crypto.createHash('sha256').update('abc').digest('hex'); console.log(`${shaOk ? 'PASS' : 'FAIL'}  lua sha256('abc')`); process.exit(bad + (shaOk ? 0 : 1));
