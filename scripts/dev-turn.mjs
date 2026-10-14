// Throwaway TURN server for local testing that validates coturn-style time-limited credentials
// (use-auth-secret: username "<expiry>:<id>", password = base64(HMAC-SHA1(secret, username))).
// node-turn is not a project dependency:  npm i --no-save node-turn
//   TURN_SECRET=... node scripts/dev-turn.mjs [port=3478]
// Then run the app with TURN_SECRET=<same> TURN_URLS=turn:127.0.0.1:<port>
import { createHmac } from 'node:crypto';
import Turn from 'node-turn';

const secret = process.env.TURN_SECRET;
if (!secret) { console.error('Set TURN_SECRET'); process.exit(2); }
const port = Number(process.argv[2] || 3478);
let ok = 0, rejected = 0;
const credentials = new Proxy({}, {
  get(_t, username) {
    if (typeof username !== 'string') return undefined;
    const exp = Number(username.split(':')[0]);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) { rejected++; return undefined; } // expired / malformed
    ok++;
    return createHmac('sha1', secret).update(username).digest('base64');
  },
});
const server = new Turn({ listeningPort: port, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', realm: 'camchat', credentials, debugLevel: 'ERROR' });
server.start();
console.log(`dev TURN (use-auth-secret) on 127.0.0.1:${port}`);
setInterval(() => console.log(`[turn] credential lookups ok=${ok} rejected=${rejected}`), 15000).unref?.();
