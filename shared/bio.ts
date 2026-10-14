/** Profile bio: up to 280 characters of markdown-lite (bold, italic, code, links). */
export const BIO_MAX = 280;

/** Normalize a bio: strip control characters (keep line breaks), at most 2 blank lines in a row, trimmed. */
export function cleanBio(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .trim();
}
