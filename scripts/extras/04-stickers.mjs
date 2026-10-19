  // @@X4 sticker packs
  if (want('X4')) {
    const base = `/api/rooms/${encodeURIComponent(ROOM)}`;
    ok((await E.j.req(`${base}/sticker-packs`, { name: 'nope' })).status === 403, 'X4: only the owner or staff create packs');
    const p1 = await D.j.req(`${base}/sticker-packs`, { name: 'Cats' });
    const pack = p1.packs?.find((p) => p.name === 'Cats');
    ok(p1.ok && pack, 'X4: owner creates a pack');
    const up = async (u, name, buf, type = 'image/png', pk = pack.id) => { const fd = new FormData(); fd.append('name', name); fd.append('sticker', new Blob([buf], { type }), `${name}.png`); return u.j.form(`${base}/sticker-packs/${pk}/stickers`, fd); };
    const u1 = await up(D, 'happy', await png('#ffcc00', 300));
    ok(u1.ok && u1.sticker.status === 'pending', `X4: owner upload waits for staff review (${u1.sticker?.status})`);
    ok((await up(D, 'big', Buffer.alloc(1_100_000, 1))).status === 400, 'X4: files over 1 MB are refused');
    ok((await up(D, 'txt', Buffer.from('hello world'), 'text/plain')).status === 400, 'X4: non-images are refused');
    ok((await up(D, 'Bad Name', await png('#00ff00'))).status === 400, 'X4: bad sticker names are refused');
    ok((await up(E, 'sneaky', await png('#00ff00'))).status === 403, 'X4: members cannot upload');
    const meta = await sharp(Buffer.from(await (await fetch(`${BASE}${u1.sticker.url}`, { headers: { cookie: D.j.header() } })).arrayBuffer())).metadata();
    ok(meta.format === 'webp' && meta.width <= 256 && meta.height <= 256, `X4: stored as WebP at most 256px (${meta.format} ${meta.width})`);
    ok((await fetch(`${BASE}${u1.sticker.url}`, { headers: { cookie: E.j.header() } })).status === 404, 'X4: pending stickers are hidden from members');
    ok(!(await E.j.req(`${base}/stickers`)).packs.some((p) => p.stickers.length), 'X4: members only see approved stickers');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: u1.sticker.id })).ok === false, 'X4: a pending sticker cannot be sent');
    ok((await E.j.req(`/api/admin/stickers?status=pending`)).status === 403, 'X4: review queue is staff-only');
    const q = await S.j.req('/api/admin/stickers?status=pending');
    ok(q.stickers?.some((s) => s.id === u1.sticker.id), 'X4: staff see the sticker in the review queue');
    const u2 = await up(D, 'grumpy', await png('#3366ff', 128));
    // admin UI review (approve one, reject the other)
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(S, width);
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-tab="stickers"]', { timeout: 15000 }); await dismiss(page);
      await page.$eval('[data-tab="stickers"]', (b) => b.click());
      await page.waitForSelector('[data-admin-sticker]', { timeout: 6000 }).catch(() => {});
      if (width < 800) { await page.$eval('[data-action="stickers-approved"]', (b) => b.click()); await page.waitForSelector('[data-admin-sticker="happy"]', { timeout: 5000 }).catch(() => {}); }
      ok(await page.$(`[data-admin-sticker="happy"]`), `X4 ${width}: admin Stickers tab lists ${width < 800 ? 'approved' : 'pending'} stickers`);
      await shot(page, `x-stickers-admin-${width}`);
      if (width === 1366) {
        await page.$eval('[data-admin-sticker="happy"] [data-action="sticker-approve"]', (b) => b.click()); await sleep(800);
        page.once('dialog', (d) => d.accept('Too blurry'));
        await page.$eval('[data-admin-sticker="grumpy"] [data-action="sticker-reject"]', (b) => b.click()); await sleep(800);
      }
      await ctx.close();
    }
    const after = (await D.j.req(`${base}/stickers`)).packs.flatMap((p) => p.stickers);
    ok(after.find((s) => s.id === u1.sticker.id)?.status === 'approved' && after.find((s) => s.id === u2.sticker.id)?.status === 'rejected' && after.find((s) => s.id === u2.sticker.id)?.note === 'Too blurry', 'X4: approve and reject (with note) from the admin tab');
    const ev = events(D.s, 'chat:message');
    await sleep(800);
    const sent = await emit(E.s, 'chat:send', { text: '', sticker: u1.sticker.id });
    await waitFor(() => ev.some((m) => /\[\[sticker:/.test(m.text)), 3000);
    ok(sent.ok !== false && ev.some((m) => m.text === `[[sticker:${u1.sticker.id}]]`), 'X4: members send an approved sticker');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: u2.sticker.id })).ok === false, 'X4: a rejected sticker cannot be sent');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: 'f'.repeat(32) })).ok === false, 'X4: unknown sticker ids are refused');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      const shown = await page.waitForFunction(() => { const i = document.querySelector('.chat-log img.sticker'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 6000 }).then(() => true, () => false);
      ok(shown, `X4 ${width}: stickers render in chat`);
      await page.$eval('[data-action="stickers"]', (b) => b.click()).catch(() => {});
      await page.waitForSelector('[data-sticker="happy"]', { timeout: 5000 }).catch(() => {});
      const opts = await page.$$eval('[data-testid="sticker-pop"] [data-sticker]', (x) => x.map((b) => b.dataset.sticker));
      ok(opts.includes('happy') && !opts.includes('grumpy'), `X4 ${width}: the sticker picker shows approved stickers only (${opts})`);
      const fits = await page.$eval('[data-testid="sticker-pop"]', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; }).catch(() => false);
      ok(fits, `X4 ${width}: the picker fits on screen`);
      await shot(page, `x-stickers-picker-${width}`);
      if (width === 1366) {
        const n = await page.$$eval('.chat-log img.sticker', (x) => x.length);
        await page.$eval('[data-sticker="happy"]', (b) => b.click());
        ok(await page.waitForFunction((n) => document.querySelectorAll('.chat-log img.sticker').length > n, { timeout: 5000 }, n).then(() => true, () => false), 'X4: sending from the picker posts the sticker');
      }
      const has = await openSettings(page, width, 'stickers');
      if (has) await page.waitForSelector('[data-panel="stickers"] [data-pack="Cats"]', { timeout: 5000 }).catch(() => {});
      ok(has && !!(await page.$('[data-pack="Cats"] [data-sticker-status="rejected"]')), `X4 ${width}: room settings show packs with review status`);
      if (has) await shot(page, `x-stickers-settings-${width}`);
      await ctx.close();
    }
    for (let i = 0; i < 2; i++) await D.j.req(`${base}/sticker-packs`, { name: `P${i}` });
    ok((await D.j.req(`${base}/sticker-packs`, { name: 'P9' })).status === 409, 'X4: at most 3 packs per room');
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM }); await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM }); await fresh0(S); await emit(S.s, 'room:join', { roomId: ROOM });
  }
