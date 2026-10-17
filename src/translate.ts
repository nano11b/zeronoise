/** Batch G1: tap-to-translate. Prefers the browser's on-device Translator/LanguageDetector (Chrome);
 *  falls back to the admin's self-hosted LibreTranslate through /api/translate. No paid keys anywhere. */
import { api } from './api';

export type TranslateResult = { text: string; from: string | null; via: 'browser' | 'server'; same?: boolean };
export class TranslateUnavailable extends Error {}

export const targetLang = () => (navigator.language || 'en').split('-')[0].toLowerCase();
let serverOk: Promise<boolean> | null = null;
export const serverTranslate = () => (serverOk ??= fetch('/api/translate/config').then((r) => r.json()).then((j) => !!j?.server).catch(() => false));
export const resetTranslateConfig = () => { serverOk = null; };
const g = globalThis as any;
export const browserTranslate = () => typeof g.Translator?.create === 'function';
const translators = new Map<string, Promise<any>>();
let detector: Promise<any> | null = null;

async function viaBrowser(text: string, target: string): Promise<TranslateResult | null> {
  if (!browserTranslate()) return null;
  try {
    let from: string | null = null;
    if (typeof g.LanguageDetector?.create === 'function') {
      detector ??= g.LanguageDetector.create();
      const found = await (await detector).detect(text);
      from = found?.[0]?.detectedLanguage && found[0].detectedLanguage !== 'und' ? String(found[0].detectedLanguage).split('-')[0] : null;
    }
    if (!from) return null;
    if (from === target) return { text, from, via: 'browser', same: true };
    const avail = await g.Translator.availability?.({ sourceLanguage: from, targetLanguage: target });
    if (avail === 'unavailable') return null;
    const key = `${from}>${target}`;
    if (!translators.has(key)) translators.set(key, g.Translator.create({ sourceLanguage: from, targetLanguage: target }));
    const out = await (await translators.get(key)).translate(text);
    return { text: String(out), from, via: 'browser' };
  } catch { return null; }
}

export async function translateText(text: string, target = targetLang()): Promise<TranslateResult> {
  const b = await viaBrowser(text, target);
  if (b) return b;
  if (await serverTranslate()) {
    const j = await api<{ text: string; from: string | null }>('/api/translate', { text, target });
    return { text: j.text, from: j.from, via: 'server', same: j.text.trim() === text.trim() };
  }
  throw new TranslateUnavailable("Translation isn't available here. Use a recent Chrome (on-device translation), or ask an admin to set a LibreTranslate server.");
}

const names = typeof Intl !== 'undefined' && (Intl as any).DisplayNames ? new (Intl as any).DisplayNames([targetLang()], { type: 'language' }) : null;
export const langName = (code: string | null) => { if (!code) return 'another language'; try { return names?.of(code) ?? code; } catch { return code; } };
