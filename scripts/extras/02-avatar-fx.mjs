  // @@X2 profile effects (avatar frames / glows)
  if (want('X2')) {
    const r = await D.j.req('/api/me/avatar-fx', { fx: 'breathe' }, 'PATCH');
    ok(r.ok && r.avatarFx === 'breathe', 'X2: a profile effect is saved');
    ok((await D.j.req('/api/me/avatar-fx', { fx: 'url(x)' }, 'PATCH')).status === 400, 'X2: unknown effects are refused');
    const me = await D.j.req('/api/me');
    ok(me.account?.avatarFx === 'breathe', 'X2: /api/me carries it');
    const ev = events(E.s, 'chat:message');
    await emit(D.s, 'chat:send', { text: `framed ${R}` });
    ok(await waitFor(() => ev.some((m) => m.text === `framed ${R}` && m.avatarFx === 'breathe')), 'X2: chat lines carry the effect');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(E, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      const av = (p) => p.evaluate((t) => { const line = [...document.querySelectorAll('.chat-log .msg')].find((e) => e.textContent.includes(t)); const a = line?.querySelector('.user-avatar'); if (!a) return null; const cs = getComputedStyle(a); return { cls: a.className, shadow: cs.boxShadow, anim: cs.animationName }; }, `framed ${R}`);
      const a1 = await av(page);
      ok(a1 && /avatar-fx-breathe/.test(a1.cls) && a1.shadow !== 'none' && a1.anim === 'avatar-breathe', `X2 ${width}: the sender's avatar shows the glow`, JSON.stringify(a1));
      await shot(page, `x-avatar-fx-room-${width}`);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await sleep(150);
      const a2 = await av(page);
      ok(a2 && a2.anim === 'none' && a2.shadow !== 'none', `X2 ${width}: reduced motion keeps the frame but stops the animation`);
      await page.emulateMediaFeatures([]);
      // viewer toggle in the Profile dialog
      await page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
      await page.waitForSelector('[data-action="open-profile"]', { timeout: 6000 }); await page.$eval('[data-action="open-profile"]', (b) => b.click());
      await page.waitForSelector('[data-section="avatar-fx"]', { timeout: 6000 });
      ok((await page.$$('[data-section="avatar-fx"] [data-avatar-fx]')).length >= 6, `X2 ${width}: the Profile dialog offers the effects`);
      await page.$eval('[data-section="avatar-fx"]', (d) => d.scrollIntoView({ block: 'start' })); await sleep(200);
      ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `X2 ${width}: the section fits`);
      await shot(page, `x-avatar-fx-profile-${width}`);
      await page.$eval('[data-action="hide-avatar-fx"]', (c) => c.click()); await sleep(200);
      await page.keyboard.press('Escape'); await sleep(300);
      const a3 = await av(page);
      ok(a3 && a3.shadow === 'none' && a3.anim === 'none', `X2 ${width}: "hide profile effects" turns them off for this viewer`);
      ok(await page.evaluate(() => localStorage.getItem('zn.hideAvatarFx') === '1'), `X2 ${width}: the setting is remembered on this device`);
      await ctx.close();
    }
    await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM });
  }
