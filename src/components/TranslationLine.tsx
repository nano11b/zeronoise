import { langName } from '../translate';
export type TranslationState = { busy?: boolean; text?: string; from?: string | null; via?: 'browser' | 'server'; same?: boolean; error?: string };
export function TranslationLine({ t, onHide }: { t: TranslationState; onHide: () => void }) {
  return (
    <div className={`msg-translation${t.error ? ' err' : ''}`} data-translation={t.via ?? (t.error ? 'unavailable' : 'busy')} role="status" aria-live="polite">
      {t.busy ? <span className="muted">Translating…</span>
        : t.error ? <span>{t.error}</span>
        : t.same ? <span className="muted">Already in {langName(t.from ?? null)}.</span>
        : <><span className="tr-text">{t.text}</span> <span className="muted small">· from {langName(t.from ?? null)}{t.via === 'server' ? ' (site translator)' : ''}</span></>}
      {' '}<button type="button" className="linklike small" onClick={onHide} data-action="translate-hide">{t.error ? 'Dismiss' : 'Show original'}</button>
    </div>
  );
}
