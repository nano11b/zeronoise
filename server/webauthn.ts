/**
 * Minimal WebAuthn relying party (passkeys): "none" attestation, ES256 (-7) and RS256 (-257) keys.
 * Verifies clientDataJSON (type, challenge, origin), authenticator data (rpIdHash, flags, counter)
 * and assertion signatures with node:crypto. No dependencies.
 */
import { createHash, createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';

// ---- CBOR (just the subset authenticators emit) ----
function cborDecode(buf: Buffer): { value: unknown; offset: number } {
  let off = 0;
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[off++];
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(off)); off += 8; return v; }
    throw new Error('cbor: indefinite length not supported');
  };
  const item = (): unknown => {
    const b = buf[off++]; const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); const v = buf.subarray(off, off + n); off += n; return Buffer.from(v); }
      case 3: { const n = readLen(info); const v = buf.toString('utf8', off, off + n); off += n; return v; }
      case 4: { const n = readLen(info); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = readLen(info); const m = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('cbor: unsupported simple value');
      default: throw new Error(`cbor: major type ${major} not supported`);
    }
  };
  const value = item();
  return { value, offset: off };
}

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: unknown) => { if (typeof s !== 'string' || s.length > 4096 || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url'); return Buffer.from(s, 'base64url'); };
export const newChallenge = () => b64u(randomBytes(32));

interface AuthData { rpIdHash: Buffer; flags: number; up: boolean; uv: boolean; signCount: number; credId?: Buffer; coseKey?: Map<unknown, unknown> }
function parseAuthData(ad: Buffer): AuthData {
  if (ad.length < 37) throw new Error('authenticator data too short');
  const flags = ad[32];
  const out: AuthData = { rpIdHash: ad.subarray(0, 32), flags, up: !!(flags & 1), uv: !!(flags & 4), signCount: ad.readUInt32BE(33) };
  if (flags & 0x40) {
    let off = 37 + 16; // aaguid
    const len = ad.readUInt16BE(off); off += 2;
    out.credId = ad.subarray(off, off + len); off += len;
    const { value } = cborDecode(ad.subarray(off));
    out.coseKey = value as Map<unknown, unknown>;
  }
  return out;
}
function coseToJwk(k: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = k.get(1), alg = k.get(3) as number;
  if (kty === 2 && alg === -7 && k.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(k.get(-2) as Buffer), y: b64u(k.get(-3) as Buffer) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: b64u(k.get(-1) as Buffer), e: b64u(k.get(-2) as Buffer) } };
  throw new Error('unsupported key type (use ES256 or RS256)');
}
function checkClientData(raw: Buffer, type: string, challenge: string, origins: string[]) {
  const cd = JSON.parse(raw.toString('utf8')) as { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (cd.challenge !== challenge) throw new Error('challenge mismatch');
  if (!cd.origin || !origins.includes(cd.origin)) throw new Error(`origin not allowed: ${cd.origin}`);
  if (cd.crossOrigin) throw new Error('cross-origin ceremony refused');
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export interface RegisteredKey { credId: string; jwk: JsonWebKey; alg: number; signCount: number; uv: boolean }
export function verifyRegistration(cred: { id?: unknown; response?: { clientDataJSON?: unknown; attestationObject?: unknown } }, challenge: string, rpId: string, origins: string[]): RegisteredKey {
  const clientData = fromB64u(cred.response?.clientDataJSON);
  checkClientData(clientData, 'webauthn.create', challenge, origins);
  const att = cborDecode(fromB64u(cred.response?.attestationObject)).value as Map<string, unknown>;
  const ad = parseAuthData(att.get('authData') as Buffer);
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('rpId mismatch');
  if (!ad.up) throw new Error('user presence missing');
  if (!ad.credId || !ad.coseKey) throw new Error('no credential in attestation');
  const { jwk, alg } = coseToJwk(ad.coseKey);
  createPublicKey({ key: jwk, format: 'jwk' }); // throws on a bad key
  if (typeof cred.id === 'string' && cred.id !== b64u(ad.credId)) throw new Error('credential id mismatch');
  return { credId: b64u(ad.credId), jwk, alg, signCount: ad.signCount, uv: ad.uv };
}

export function verifyAssertion(cred: { response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown } }, key: { jwk: JsonWebKey; alg: number; signCount: number },
  challenge: string, rpId: string, origins: string[], requireUv: boolean): { signCount: number; uv: boolean } {
  const clientData = fromB64u(cred.response?.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', challenge, origins);
  const adRaw = fromB64u(cred.response?.authenticatorData);
  const ad = parseAuthData(adRaw);
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('rpId mismatch');
  if (!ad.up) throw new Error('user presence missing');
  if (requireUv && !ad.uv) throw new Error('user verification required');
  const v = createVerify('SHA256');
  v.update(Buffer.concat([adRaw, sha256(clientData)]));
  if (!v.verify(createPublicKey({ key: key.jwk, format: 'jwk' }), fromB64u(cred.response?.signature))) throw new Error('bad signature');
  // a counter that goes backwards means a cloned authenticator (0/0 = authenticator without a counter)
  if ((ad.signCount || key.signCount) && ad.signCount <= key.signCount) throw new Error('signature counter did not increase');
  return { signCount: ad.signCount, uv: ad.uv };
}
