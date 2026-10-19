  // @@X1 name gradients
  if (want('X1')) {
    const g = await D.j.req('/api/me/color', { gradient: ['#9fd8ff', '#d7b8ff'] }, 'PATCH');
    ok(g.ok && g.chatColor === 'g:#9fd8ff,#d7b8ff', 'X1: a name gradient is saved', JSON.stringify(g));
    const dk = await E.j.req('/api/me/color', { gradient: ['#111111', '#ffd166', '#300000'] }, 'PATCH');
    const st = (dk.chatColor || '').slice(2).split(',');
    ok(dk.ok && dk.adjusted && st.length === 3 && worstOf(st) >= 4.5, `X1: dark name-gradient stops are lightened (${dk.chatColor})`);
    for (const b of [{ gradient: ['#ffd166'] }, { gradient: ['#ffd166', 'red;x'] }, { color: 'g:#zzz' }]) ok((await E.j.req('/api/me/color', b, 'PATCH')).status === 400, `X1: refused ${JSON.stringify(b)}`);
    ok((await E.j.req('/api/me/color', { color: 'teal' }, 'PATCH')).chatColor === 'teal', 'X1: palette name colours still work');
    await emit(D.s, 'chat:send', { text: `named ${R}` }); await sleep(300);
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(700);
      const n = await page.evaluate((nick) => { const el = [...document.querySelectorAll('.chat-log .nick-label.from')].find((e) => e.textContent === nick); if (!el) return null; const cs = getComputedStyle(el); return { cls: el.className, bg: cs.backgroundImage, fill: cs.webkitTextFillColor, color: cs.color, anim: cs.animationName }; }, D.nick);
      ok(n && /nick-grad/.test(n.cls) && /linear-gradient/.test(n.bg) && n.fill === 'rgba(0, 0, 0, 0)' && n.color === 'rgb(159, 216, 255)', `X1 ${width}: names render with the gradient (solid fallback = first stop)`, JSON.stringify(n));
      ok(n?.anim === 'none', `X1 ${width}: not animated`);
      await page.$eval('[data-action="composer-plus"]', (b) => b.click()); await sleep(250);
      await page.$eval('[data-action="name-style"]', (b) => b.click()); await sleep(300);
      const sw = await page.$$eval('[data-name-gradient]', (x) => x.length);
      const same = await page.evaluate(() => { const a = document.querySelector('[data-name-gradient]'), b = document.querySelector('.name-style-pop .color-swatch:not(.reset)'); return !!a && a.classList.contains('color-swatch') && !!b; });
      ok(sw >= 4 && same, `X1 ${width}: the name picker in the chat bar offers the same gradients, same swatch style`);
      await page.$eval('[data-field="name-stop-0"]', (i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '#151515'); i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
      ok(!!(await page.$('[data-testid="name-grad-adjusted"]')), `X1 ${width}: a dark custom stop is flagged before saving`);
      const fit = await page.evaluate(() => { const r = document.querySelector('.name-style-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0; });
      ok(fit, `X1 ${width}: the name picker fits`);
      await shot(page, `x-name-gradient-${width}`);
      await ctx.close();
    }
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
