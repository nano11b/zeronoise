import { useEffect, useState } from 'react';
import { getTts, onTts, roomMuted, setRoomMuted, setTts, ttsSay, ttsSupported, type TtsMode } from '../tts';

/** Batch H10: "Read messages aloud" section of Audio & video settings. */
export function TtsSettings({ room }: { room?: { id: string; name: string } | null }) {
  const [p, setP] = useState(getTts());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => onTts(() => setP(getTts())), []);
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);
  if (!ttsSupported()) return <fieldset className="field av-tts" data-testid="av-tts"><legend>Read messages aloud</legend><p className="muted small" data-testid="tts-unsupported">This browser can't read text aloud.</p></fieldset>;
  const modes: [TtsMode, string][] = [['off', 'Off'], ['mentions', 'Mentions and whispers only'], ['all', 'All messages in the room I’m in']];
  return (
    <fieldset className="field av-tts" data-testid="av-tts">
      <legend>Read messages aloud</legend>
      <div role="radiogroup" aria-label="Read aloud">
        {modes.map(([m, label]) => (
          <label key={m} className="check-row"><input type="radio" name="tts-mode" value={m} checked={p.mode === m} onChange={() => setTts({ mode: m })} data-tts-mode={m} /> <span>{label}</span></label>
        ))}
      </div>
      <label className="field"><span>Voice</span>
        <select value={p.voiceURI} onChange={(e) => setTts({ voiceURI: e.target.value })} data-action="tts-voice">
          <option value="">Browser default</option>
          {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
        </select>
      </label>
      <label className="field"><span>Speed {p.rate.toFixed(1)}×</span>
        <input type="range" min={0.5} max={2} step={0.1} value={p.rate} onChange={(e) => setTts({ rate: Number(e.target.value) })} data-action="tts-rate" aria-valuetext={`${p.rate.toFixed(1)} times`} />
      </label>
      <label className="field"><span>Volume {Math.round(p.volume * 100)}%</span>
        <input type="range" min={0} max={1} step={0.05} value={p.volume} onChange={(e) => setTts({ volume: Number(e.target.value) })} data-action="tts-volume" aria-valuetext={`${Math.round(p.volume * 100)} percent`} />
      </label>
      {room && <label className="check-row"><input type="checkbox" checked={roomMuted(room.id)} onChange={(e) => setRoomMuted(room.id, e.target.checked)} data-action="tts-room-mute" /> <span>Don’t read #{room.name} aloud</span></label>}
      <p className="muted small">Your own messages are never read. Busy rooms are thinned out so it can’t flood you.</p>
      <button type="button" className="btn ghost small-btn" data-action="tts-test" onClick={() => ttsSay(`test-${Date.now()}`, 'test', 'This is how messages will sound.', { force: true })}>▶ Test voice</button>
    </fieldset>
  );
}
