/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-15
 * (up to 412 bytes, plenty for an otpauth:// URL). No dependencies; returns a module matrix.
 */
// [ec codewords per block, blocks in group 1, data codewords per block g1, blocks g2, data cw g2]
const M_TABLE: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 0],
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];

// GF(256) with 0x11D
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) { const next = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); } g = next; }
  return g;
}
function rsEncode(data: number[], n: number): number[] {
  const gen = rsGenerator(n); const res = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) { const c = res[i]; if (c) for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], c); }
  return res.slice(data.length);
}
const dataCapacity = (v: number) => { const t = M_TABLE[v]; return t[1] * t[2] + t[3] * t[4]; };

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 15; ver++) { const cc = ver < 10 ? 8 : 16; if (4 + cc + bytes.length * 8 <= dataCapacity(ver) * 8) break; }
  if (ver > 15) throw new Error('QR: text too long');
  const cap = dataCapacity(ver);
  // bit stream
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xec);
  // blocks + interleave
  const [ec, b1, d1, b2, d2] = M_TABLE[ver];
  const blocks: number[][] = []; let off = 0;
  for (let i = 0; i < b1; i++) { blocks.push(data.slice(off, off + d1)); off += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(data.slice(off, off + d2)); off += d2; }
  const ecs = blocks.map((b) => rsEncode(b, ec));
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]);
  // matrix
  const size = ver * 4 + 17;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    const last = al[al.length - 1];
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue; // finder corners
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // dark module
  // reserve format + version areas
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) set(8, size - 1 - i, false); if (!fn[size - 1 - i][8]) set(size - 1 - i, 8, false); }
  if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, size - 11 + j, false); set(size - 11 + j, i, false); }
  // place data
  const dbits: number[] = []; for (const b of out) for (let i = 7; i >= 0; i--) dbits.push((b >>> i) & 1);
  let k = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) if (!fn[r][c]) { m[r][c] = k < dbits.length ? dbits[k] === 1 : false; k++; }
    }
    up = !up;
  }
  const MASKS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const bch = (data: number, poly: number, polyDeg: number) => { let d = data << polyDeg; const top = (x: number) => 31 - Math.clz32(x); while (d && top(d) >= polyDeg) d ^= poly << (top(d) - polyDeg); return d; };
  const withMask = (mask: number) => {
    const g = m.map((row) => row.slice()) as boolean[][];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) g[r][c] = !g[r][c];
    const fdata = (0b00 << 3) | mask; // level M = 00
    const fmt = ((fdata << 10) | bch(fdata, 0x537, 10)) ^ 0x5412;
    const fb = (i: number) => ((fmt >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g[i][8] = fb(i);
    g[7][8] = fb(6); g[8][8] = fb(7); g[8][7] = fb(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = fb(i);
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = fb(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = fb(i);
    if (ver >= 7) {
      const vinfo = (ver << 12) | bch(ver, 0x1f25, 12);
      for (let i = 0; i < 18; i++) { const bit = ((vinfo >>> i) & 1) === 1; const a = Math.floor(i / 3), b = size - 11 + (i % 3); g[a][b] = bit; g[b][a] = bit; }
    }
    return g;
  };
  const penalty = (g: boolean[][]) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = pass ? g[j][i] : g[i][j], b = pass ? g[j - 1][i] : g[i][j - 1];
        if (a === b) run++; else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3; }
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const rev = [...pat].reverse();
    for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) for (const pp of [pat, rev]) {
      if (pp.every((v, i) => g[r][c + i] === v)) p += 40;
      if (pp.every((v, i) => g[c + i][r] === v)) p += 40;
    }
    let dark = 0; for (const row of g) for (const v of row) if (v) dark++;
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };
  let best: boolean[][] | null = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) { const g = withMask(mask); const p = penalty(g); if (p < bestP) { bestP = p; best = g; } }
  return best!;
}

/** SVG markup (4-module quiet zone), dark on white so phone cameras read it in any theme. */
export function qrSvg(text: string, px = 4): string {
  const g = qrMatrix(text); const n = g.length + 8;
  let d = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
