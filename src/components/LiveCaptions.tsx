import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';

/**
 * Batch F7: live captions in voice rooms. Each speaker opts in; their browser's speech recognition (Web Speech API)
 * turns their speech into text and only the text is sent to the room. Listeners just read it, in any browser.
 */
type Line = { id: string; nick: string; text: string; final: boolean; ts: number };
type Rec = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
const SR = () => (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
export const captionsSupported = () => typeof window !== 'undefined' && !!SR();
const SHOW_KEY = 'zn.captions.show';
const LINE_MS = 7000;

export function LiveCaptions({ roomId, myNick }: { roomId: string; myNick: string }) {
  const [show, setShow] = useState(() => localStorage.getItem(SHOW_KEY) !== '0');
  const [sharing, setSharing] = useState(false);
  const [err, setErr] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [, tick] = useState(0);
  const rec = useRef<Rec | null>(null);
  const want = useRef(false);
  const supported = captionsSupported();
  useEffect(() => {
    const on = (p: Line & { roomId: string }) => {
      if (p.roomId !== roomId) return;
      setLines((cur) => [...cur.filter((l) => !(l.id === p.id && !l.final)), { id: p.id, nick: p.nick, text: p.text, final: p.final, ts: p.ts }].slice(-6));
    };
    socket.on('caption', on);
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => { socket.off('caption', on); window.clearInterval(t); };
  }, [roomId]);
  const stop = () => { want.current = false; setSharing(false); try { rec.current?.stop(); } catch { /* */ } rec.current = null; };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const start = () => {
    const C = SR(); if (!C) return;
    setErr('');
    const r = new C(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || 'en-US';
    let lastSent = 0;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]; const text = res[0]?.transcript ?? '';
        const now = Date.now();
        if (!res.isFinal && now - lastSent < 300) continue; // interim lines: a few per second is plenty
        lastSent = now;
        socket.emit('caption:send', { text, final: res.isFinal }, () => {});
        setLines((cur) => [...cur.filter((l) => !(l.id === 'me' && !l.final)), { id: 'me', nick: myNick, text, final: res.isFinal, ts: now }].slice(-6));
      }
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setErr('Microphone or speech service was blocked.'); stop(); } };
    r.onend = () => { if (want.current) { try { r.start(); } catch { /* restarts on the next end */ } } };
    rec.current = r; want.current = true;
    try { r.start(); setSharing(true); } catch { setErr('Could not start captions.'); stop(); }
  };
  const visible = lines.filter((l) => Date.now() - l.ts < LINE_MS);
  return (
    <div className="captions-box" data-testid="captions-box">
      <div className="captions-controls">
        <button type="button" className={`btn ghost small-btn${show ? ' on' : ''}`} aria-pressed={show} data-action="captions-show" onClick={() => { const v = !show; setShow(v); localStorage.setItem(SHOW_KEY, v ? '1' : '0'); }}>CC {show ? 'on' : 'off'}</button>
        {supported
          ? <button type="button" className={`btn ghost small-btn${sharing ? ' on' : ''}`} aria-pressed={sharing} data-action="captions-share" onClick={() => (sharing ? stop() : start())}>{sharing ? 'Stop sharing my captions' : 'Share my captions'}</button>
          : <span className="small muted" data-testid="captions-unsupported">Sharing your own captions needs a browser with speech recognition (Chrome, Edge or Safari). You can still read other people's captions here.</span>}
        {sharing && <span className="small muted" data-testid="captions-note">Your browser's speech service turns your speech into text (in Chrome it is processed by Google); only the text is sent to the room.</span>}
        {err && <span className="small error">{err}</span>}
      </div>
      {show && visible.length > 0 && (
        <div className="captions" role="log" aria-live="polite" aria-label="Live captions" data-testid="captions">
          {visible.map((l) => <p key={`${l.id}-${l.ts}`} className={l.final ? 'final' : 'interim'}><b>{l.nick}:</b> {l.text}</p>)}
        </div>
      )}
    </div>
  );
}
