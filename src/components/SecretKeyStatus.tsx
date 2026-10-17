import { useEffect, useState } from 'react';
import { api } from '../api';

interface St { keySet: boolean; keyTooShort: boolean; plaintext: number; encrypted: number; unreadable: number }
const SETUP = 'sudo bash /opt/camchat/deploy/secret-key-env.sh';

function useStatus() {
  const [st, setSt] = useState<St | null>(null);
  useEffect(() => { api<St>('/api/admin/security-status').then(setSt).catch(() => {}); }, []);
  return st;
}
/** One line across the admin panel while the key is missing or wrong. */
export function SecretKeyBanner({ onOpen }: { onOpen: () => void }) {
  const st = useStatus();
  if (!st || (st.keySet && !st.unreadable)) return null;
  return (
    <div className="banner warn" role="status" data-testid="secret-key-banner">
      {st.keySet ? `${st.unreadable} two-factor secret(s) were encrypted with a different key.` : 'Two-factor secrets are stored unencrypted: CAMCHAT_SECRET_KEY is not set.'}{' '}
      <button type="button" className="link-btn" onClick={onOpen}>Details</button>
    </div>
  );
}
export function SecretKeyStatus() {
  const st = useStatus();
  if (!st) return null;
  return (
    <div className={`secret-key ${st.keySet && !st.unreadable ? 'ok' : 'warn'}`} data-testid="secret-key-status" data-keyset={st.keySet ? '1' : '0'}>
      <h3>Encryption of two-factor secrets</h3>
      {st.keySet
        ? <p className="small">On (AES-256-GCM). {st.encrypted} secret(s) encrypted{st.plaintext ? `, ${st.plaintext} still plaintext (restart to seal)` : ''}.{st.unreadable ? ` ${st.unreadable} cannot be read with this key: those people need a recovery code.` : ''}</p>
        : <p className="small">Off{st.keyTooShort ? ' (the key is shorter than 32 characters)' : ''}: {st.plaintext} secret(s) stored in plaintext{st.encrypted ? `; ${st.encrypted} encrypted secret(s) cannot be read until the key is restored` : ''}. To turn it on, run on the server (the key is generated there and never shown):</p>}
      {!st.keySet && <pre className="small"><code>{SETUP}</code></pre>}
      <p className="small muted">Keep a copy of /etc/camchat.env: without the key, encrypted secrets cannot be read and people fall back to recovery codes.</p>
    </div>
  );
}
