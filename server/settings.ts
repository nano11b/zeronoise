/** Batch G: small admin-set site settings (key/value, no secrets in plaintext logs). */
import { q } from './db';
export const getSetting = (key: string): string | null => ((q('SELECT value FROM site_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null);
export function setSetting(key: string, value: string | null, by: string) {
  void by; // who changed it is in the mod log
  q('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value ?? '');
}
