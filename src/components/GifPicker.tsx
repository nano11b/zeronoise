import { useEffect, useRef, useState, type RefObject } from 'react';
import { useEscape } from '../a11y';
import { gifMarkdown } from '../../shared/gifs';

interface GifHit {
  id: string;
  previewUrl: string;
  url: string;
  width: number;
  height: number;
}

/** Search Tenor/Giphy via the server proxy and insert an allowlisted markdown image. */
export function GifPicker({
  enabled,
  value,
  onChange,
  inputRef,
}: {
  enabled: boolean;
  value: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<GifHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  // Escape closes the picker and puts focus back on its button.
  useEscape(open, () => setOpen(false), () => wrap.current?.querySelector<HTMLElement>('[aria-expanded]'));

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    let stale = false;
    const query = q.trim();
    const t = setTimeout(async () => {
      setBusy(true);
      setErr('');
      try {
        const path = query
          ? `/api/gifs/search?q=${encodeURIComponent(query)}&limit=20`
          : '/api/gifs/trending?limit=20';
        const r = await fetch(path, { credentials: 'same-origin', signal: ac.signal });
        const data = await r.json().catch(() => ({}));
        if (stale) return;
        if (!r.ok || data?.ok === false) throw new Error(data?.error || 'GIF search failed');
        setItems(Array.isArray(data.gifs) ? data.gifs : []);
      } catch (e) {
        if (stale || (e as Error).name === 'AbortError') return;
        setErr((e as Error).message);
        setItems([]);
      } finally {
        if (!stale) setBusy(false);
      }
    }, query ? 250 : 0);
    return () => { stale = true; clearTimeout(t); ac.abort(); };
  }, [open, q]);

  if (!enabled) return null;

  const insert = (url: string) => {
    const md = gifMarkdown(url);
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const piece = (start > 0 && value[start - 1] !== ' ' && value[start - 1] !== '\n' ? ' ' : '') + md;
    const next = value.slice(0, start) + piece + value.slice(end);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + piece.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="gif-wrap" ref={wrap}>
      <button
        type="button"
        className="btn ghost gif-btn"
        title="GIF"
        aria-label="Insert GIF"
        aria-expanded={open}
        data-action="gif-picker"
        onClick={() => setOpen((o) => !o)}
      >
        GIF
      </button>
      {open && (
        <div className="gif-pop" role="dialog" aria-label="GIF picker">
          <input
            className="gif-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search GIFs"
            aria-label="Search GIFs"
            autoFocus
          />
          {err && <p className="form-error small">{err}</p>}
          {busy && <p className="muted small">Loading…</p>}
          {!busy && items.length === 0 && !err && <p className="muted small">{q.trim() ? 'No GIFs.' : 'No trending GIFs.'}</p>}
          <div className="gif-grid">
            {items.map((g) => (
              <button key={g.id} type="button" className="gif-cell" onClick={() => insert(g.url)} title="Insert GIF" aria-label="Insert GIF">
                <img src={g.previewUrl} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
