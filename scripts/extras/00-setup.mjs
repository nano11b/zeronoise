const { UI_PALETTES } = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/uiTheme.js')).href);
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const worstOf = (hexes) => Math.min(...Object.values(UI_PALETTES).flatMap((p) => [p.bg, p.bg2, p.panel, p.panel2, p.primaryBg].flatMap((b) => hexes.map((h) => cr(h, b)))));
const setVal = (page, sel, v) => page.$eval(sel, (i, v) => { const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, v);
/** room settings (Info tab) -> a details section, opened and scrolled to */
const openSettings = async (page, width, section) => {
  if (width < 800) { await page.$eval('[data-action="collapse-panel"]', (b) => b.click()).catch(() => {}); await sleep(400); }
  await page.$eval('[data-action="tab-info"]', (b) => b.click()).catch(() => {}); await sleep(400);
  const ok2 = await page.waitForSelector(`details[data-section="${section}"]`, { timeout: 6000 }).then(() => true, () => false);
  if (ok2) await page.$eval(`details[data-section="${section}"]`, (d) => { d.open = true; d.scrollIntoView({ block: 'start' }); });
  await sleep(500);
  return ok2;
};
try {
  const S = await nodeUser('PpAdmin'), D = await nodeUser(`XD${R}`), E = await nodeUser(`XE${R}`);
  sockets.push(S.s, D.s, E.s);
  const ROOM = (await emit(D.s, 'room:create', { name: `extras ${R}`, topic: 't', category: 'gaming' })).roomId;
  for (const u of [D, E, S]) await emit(u.s, 'room:join', { roomId: ROOM });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
  const want = (k) => !ONLY.length || ONLY.includes(k);
