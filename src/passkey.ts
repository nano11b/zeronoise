/** Browser side of passkeys: JSON options from the server <-> navigator.credentials. */
const toBuf = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const toB64u = (b: ArrayBuffer) => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

export async function createPasskey(o: any) {
  const cred = await navigator.credentials.create({ publicKey: {
    ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c: any) => ({ ...c, id: toBuf(c.id) })),
  } }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Cancelled');
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) } };
}
export async function getPasskey(o: any) {
  const cred = await navigator.credentials.get({ publicKey: {
    ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c: any) => ({ ...c, id: toBuf(c.id) })),
  } }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Cancelled');
  const r = cred.response as AuthenticatorAssertionResponse;
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : null } };
}
export const passkeyError = (e: unknown) => { const n = (e as Error)?.name; return n === 'NotAllowedError' ? 'Passkey prompt was closed or timed out.' : n === 'InvalidStateError' ? 'This device already has a passkey for your account.' : (e as Error).message; };
