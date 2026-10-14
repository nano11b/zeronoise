import { APP_NAME } from '../shared/config';
import type { MeResponse } from '../shared/types';

const DEVICE_KEY = `${APP_NAME.toLowerCase()}.device`;
export function storedDeviceId(): string | null {
  try { return localStorage.getItem(DEVICE_KEY); } catch { return null; }
}
export function storeDeviceId(id: string) {
  try { localStorage.setItem(DEVICE_KEY, id); } catch { /* private mode */ }
}

/** JSON fetch with the CSRF header the server requires on state-changing calls. */
export async function api<T = any>(url: string, body?: unknown, method?: string): Promise<T> {
  const headers: Record<string, string> = { 'X-CSRF': '1' };
  const dev = storedDeviceId();
  if (dev) headers['X-Device-Id'] = dev;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: any = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${r.status})`);
  return data as T;
}

export async function fetchMe(): Promise<MeResponse> {
  const me = await api<MeResponse>('/api/me');
  storeDeviceId(me.deviceId);
  return me;
}
