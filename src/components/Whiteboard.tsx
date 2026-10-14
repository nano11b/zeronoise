import { PointerEvent, useEffect, useRef, useState } from 'react';
import type { BoardColor, BoardStroke } from '../../shared/types';
import { LIMITS } from '../../shared/config';
import { socket } from '../socket';

const COLORS: { id: BoardColor; hex: string; label: string }[] = [
  { id: 'green', hex: '#39ff14', label: 'Green' },
  { id: 'white', hex: '#f4fff4', label: 'White' },
  { id: 'red', hex: '#ff6b6b', label: 'Red' },
];

function hexOf(color: BoardColor) {
  return COLORS.find((c) => c.id === color)?.hex ?? '#39ff14';
}

function paint(ctx: CanvasRenderingContext2D, strokes: BoardStroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  for (const s of strokes) {
    const hex = hexOf(s.color);
    if (s.points.length === 1) {
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.arc(s.points[0][0] * w, s.points[0][1] * h, 1.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.strokeStyle = hex;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => {
      const px = x * w;
      const py = y * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}

function norm(e: PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement): [number, number] {
  const r = canvas.getBoundingClientRect();
  const x = r.width ? (e.clientX - r.left) / r.width : 0;
  const y = r.height ? (e.clientY - r.top) / r.height : 0;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

/** Room whiteboard. Stays mounted so strokes keep syncing while the panel is closed. */
export function Whiteboard({ open, canClear, initial }: { open: boolean; canClear: boolean; initial: BoardStroke[] }) {
  const [strokes, setStrokes] = useState<BoardStroke[]>(initial);
  const [color, setColor] = useState<BoardColor>('green');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const current = useRef<BoardStroke | null>(null);
  const lastSend = useRef(0);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  const emit = (stroke: BoardStroke) => {
    socket.emit('board:stroke', { id: stroke.id, color: stroke.color, points: stroke.points.slice() });
  };

  useEffect(() => {
    const onStroke = (s: BoardStroke) => {
      if (!s?.id || s.fromId === socket.id) return;
      setStrokes((prev) => {
        const i = prev.findIndex((x) => x.id === s.id);
        if (i < 0) return [...prev, s];
        const next = prev.slice();
        next[i] = s;
        return next;
      });
    };
    const onUndo = ({ id }: { id: string }) => setStrokes((prev) => prev.filter((s) => s.id !== id));
    const onClear = () => { current.current = null; setStrokes([]); };
    socket.on('board:stroke', onStroke);
    socket.on('board:undo', onUndo);
    socket.on('board:clear', onClear);
    return () => {
      socket.off('board:stroke', onStroke);
      socket.off('board:undo', onUndo);
      socket.off('board:clear', onClear);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;
    const draw = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(ctx, strokesRef.current, w, h);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [open, strokes]);

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const stroke: BoardStroke = { id: crypto.randomUUID(), fromId: socket.id ?? '', color, points: [norm(e, canvas)] };
    current.current = stroke;
    lastSend.current = Date.now();
    setStrokes((prev) => [...prev, stroke]);
    emit(stroke);
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const stroke = current.current;
    const canvas = e.currentTarget;
    if (!stroke) return;
    const p = norm(e, canvas);
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return;
    if (stroke.points.length >= LIMITS.boardPoints) {
      emit(stroke);
      const next: BoardStroke = { id: crypto.randomUUID(), fromId: socket.id ?? '', color, points: [p] };
      current.current = next;
      setStrokes((prev) => [...prev, next]);
      emit(next);
      return;
    }
    stroke.points.push(p);
    const copy = stroke.points.slice();
    setStrokes((prev) => prev.map((s) => (s.id === stroke.id ? { ...s, points: copy } : s)));
    const now = Date.now();
    if (now - lastSend.current > 200) {
      lastSend.current = now;
      emit({ ...stroke, points: copy });
    }
  };
  const onUp = () => {
    const stroke = current.current;
    current.current = null;
    if (stroke) emit({ ...stroke, points: stroke.points.slice() });
  };

  const undo = () => {
    const mine = [...strokes].reverse().find((s) => s.fromId === socket.id);
    if (!mine) return;
    setStrokes((prev) => prev.filter((s) => s.id !== mine.id));
    socket.emit('board:undo', { id: mine.id });
  };

  return (
    <div className={`board-dock${open ? '' : ' is-closed'}`} hidden={!open}>
      <div className="board-tools">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`board-swatch${color === c.id ? ' on' : ''}`}
            style={{ background: c.hex }}
            aria-label={c.label}
            aria-pressed={color === c.id}
            data-action={`board-${c.id}`}
            onClick={() => setColor(c.id)}
          />
        ))}
        <button type="button" className="btn ghost small-btn" data-action="board-undo" onClick={undo}>Undo</button>
        {canClear && <button type="button" className="btn ghost small-btn" data-action="board-clear" onClick={() => socket.emit('board:clear')}>Clear</button>}
      </div>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        aria-label="Room whiteboard"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  );
}
