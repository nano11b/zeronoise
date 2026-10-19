  // @@X8 saved messages
  if (want('X8')) {
    const ROOM2 = (await emit(E.s, 'room:create', { name: `saved ${R}`, topic: 't', category: 'gaming' })).roomId;
    const post = async (u, room, text, extra = {}) => { await sleep(700); const ev = events(u.s, 'chat:message'); await emit(u.s, 'chat:send', { text, ...extra }); await waitFor(() => ev.some((m) => m.text === text), 3000); return ev.find((m) => m.text === text); };
    await emit(D.s, 'room:join', { roomId: ROOM });
    const m1 = await post(E, ROOM, `saved one ${R}`);
    const reply = await post(E, ROOM, `thread reply ${R}`, { parentId: m1.id });
    const burn = await post(E, ROOM, `burn ${R}`, { burnTtl: 30 });
    ok((await emit(D.s, 'bookmark:toggle', { messageId: m1.id, on: true })).ok, 'X8: bookmark a room message');
    ok((await emit(D.s, 'bookmark:toggle', { messageId: reply.id, on: true })).ok, 'X8: bookmark a thread reply');
    ok((await emit(D.s, 'bookmark:toggle', { messageId: burn?.id ?? 'x', on: true })).ok === false, 'X8: burn messages cannot be saved');
    await emit(E.s, 'room:join', { roomId: ROOM2 }); await emit(D.s, 'room:join', { roomId: ROOM2 });
    const m2 = await post(E, ROOM2, `other room ${R}`);
    ok((await emit(D.s, 'bookmark:toggle', { messageId: m2.id, on: true })).ok, 'X8: bookmark in a second room');
    ok((await emit(S.s, 'bookmark:list')).bookmarks?.every((b) => ![m1.id, m2.id].includes(b.message.id)), 'X8: the list is private');
    await emit(D.s, 'room:join', { roomId: ROOM }); await emit(E.s, 'room:join', { roomId: ROOM });
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      await page.click('[data-action="profile"]'); await page.waitForSelector('[data-action="open-saved"]', { timeout: 5000 }).catch(() => {});
      ok(!!(await page.$('[data-action="open-saved"]')), `X8 ${width}: "Saved messages" is in the Your profile menu`);
      await page.$eval('[data-action="open-saved"]', (b) => b.click());
      await page.waitForSelector('[data-testid="saved-dialog"] [data-saved-row]', { timeout: 6000 }).catch(() => {});
      const rows = await page.$$eval('[data-saved-row]', (x) => x.map((e) => e.dataset.savedRow));
      ok([m1.id, reply.id, m2.id].every((id) => rows.includes(id)), `X8 ${width}: saved list has messages from both rooms and threads (${rows.length})`);
      await shot(page, `x-saved-${width}`);
      if (width === 1366) {
        await page.type('[data-field="saved-filter"]', 'other room'); await sleep(200);
        ok((await page.$$('[data-saved-row]')).length === 1, 'X8: filter the saved list');
        await page.$eval('[data-field="saved-filter"]', (i) => { i.value = ''; });
        await setVal(page, '[data-field="saved-filter"]', '');
        await page.$eval(`[data-saved-row="${m2.id}"] [data-action="saved-open"]`, (b) => b.click());
        const jumped = await page.waitForFunction((id) => !!document.querySelector(`.jump-hit[data-msg="${id}"], [data-msg="${id}"].jump-hit`), { timeout: 10000 }, m2.id).then(() => true, () => false);
        ok(jumped, 'X8: opening a saved message switches room and highlights it');
        await shot(page, `x-saved-jump-${width}`);
      } else {
        await page.$eval(`[data-saved-row="${reply.id}"] [data-action="saved-remove"]`, (b) => b.click()); await sleep(600);
        ok(!(await page.$(`[data-saved-row="${reply.id}"]`)), 'X8 390: remove from the saved list');
        const fits = await page.$eval('[data-testid="saved-dialog"]', (e) => e.getBoundingClientRect().right <= innerWidth + 1);
        ok(fits, 'X8 390: the list fits the phone');
      }
      await ctx.close();
    }
    await fresh0(D);
    ok(!(await emit(D.s, 'bookmark:list')).bookmarks.some((b) => b.message.id === reply.id), 'X8: removal is stored');
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM }); await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM });
  }
