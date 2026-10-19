  // @@X6 music queue
  if (want('X6')) {
    const qs = events(E.s, 'queue:state'); const ws = events(E.s, 'watch:state');
    const yt = (n) => `https://www.youtube.com/watch?v=${('vid' + n).padEnd(11, 'x').slice(0, 11)}`;
    const vid = (n) => ('vid' + n).padEnd(11, 'x').slice(0, 11);
    const q = async (u, ev, p) => { await sleep(150); return p === undefined ? emit(u.s, ev) : emit(u.s, ev, p); };
    await emit(D.s, 'watch:update', { action: 'clear' });
    ok((await q(E, 'queue:add', { url: 'https://www.twitch.tv/somechannel' })).ok === false, 'X6: only YouTube links can be queued');
    ok((await q(E, 'queue:add', { url: 'https://evil.example/watch?v=abc' })).ok === false, 'X6: other sites are refused');
    ok((await q(E, 'queue:add', { url: yt(1) })).ok, 'X6: a member queues a song');
    await waitFor(() => ws.some((w) => w.watch?.id === vid(1)), 3000);
    ok(ws.some((w) => w.watch?.id === vid(1) && w.action === 'load'), 'X6: with nothing playing, the first song starts on the watch player');
    await sleep(4500); for (const n of [2, 3, 4]) await q(E, 'queue:add', { url: yt(n) });
    await sleep(4500);
    const r5 = await q(E, 'queue:add', { url: yt(5) });
    ok(r5.ok === false && /3 songs/.test(r5.error), `X6: at most 3 waiting songs per person (${r5.error})`);
    ok((await q(D, 'queue:add', { url: yt(2) })).ok === false, 'X6: duplicates are refused');
    await q(D, 'queue:add', { url: yt(6) });
    const st = await q(E, 'queue:get');
    ok(st.queue.items.map((i) => i.videoId).join() === [2, 3, 4, 6].map(vid).join() && st.queue.current?.videoId === vid(1) && st.queue.canControl === false, 'X6: queue order and "now playing" are shared');
    ok((await q(E, 'queue:skip')).ok === false, 'X6: members cannot skip');
    const dItem = st.queue.items.find((i) => i.videoId === vid(6));
    ok((await q(E, 'queue:remove', { id: dItem.id })).ok === false, 'X6: members cannot remove other people\'s songs');
    ok((await q(E, 'queue:remove', { id: st.queue.items[2].id })).ok, 'X6: members remove their own songs');
    ok((await q(E, 'queue:ended', { videoId: vid(1), durationSec: 240 })).ok === false, 'X6: an early "ended" report does not skip');
    ok((await q(D, 'queue:skip')).ok, 'X6: the owner skips');
    await waitFor(() => ws.some((w) => w.watch?.id === vid(2)), 3000);
    ok(ws[ws.length - 1]?.watch?.id === vid(2), 'X6: skip plays the next song');
    // role with music control
    const role = await emit(D.s, 'roles:save', { name: 'DJ', color: '#f9a8d4', perms: ['music'] });
    ok(role.ok, 'X6: owner creates a DJ role with music control');
    await emit(D.s, 'roles:assign', { accountId: E.id, roleId: role.role.id }); await sleep(300);
    ok((await q(E, 'queue:get')).queue.canControl === true, 'X6: the DJ role can control the queue');
    ok((await q(E, 'queue:remove', { id: dItem.id })).ok, 'X6: the DJ removes someone else\'s song');
    ok((await q(E, 'queue:skip')).ok, 'X6: the DJ skips');
    await waitFor(() => ws.some((w) => w.watch?.id === vid(3)), 3000);
    ok(ws[ws.length - 1]?.watch?.id === vid(3), 'X6: queue advanced to the next song');
    await emit(D.s, 'roles:assign', { accountId: E.id, roleId: null });
    for (const n of [7, 8]) { const r = await q(D, 'queue:add', { url: yt(n) }); if (!r.ok) console.log('[add]', n, r.error); }
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(width === 1366 ? D : E, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      for (let i = 0; i < 3 && !(await page.$('[data-testid="watch-dock"]')); i++) {
        await page.click('[data-action="more"]').catch(() => {});
        await page.waitForSelector('[data-action="watch"]', { timeout: 3000 }).catch(() => {});
        await page.$eval('[data-action="watch"]', (b) => b.click()).catch(() => {}); await sleep(600);
      }
      const has = await page.waitForSelector('[data-testid="music-queue"] [data-queue-item]', { timeout: 8000 }).then(() => true, () => false);
      if (!has) { await shot(page, `x-music-queue-debug-${width}`); console.log('[dbg]', await page.evaluate(() => ({ dock: !!document.querySelector('[data-testid="watch-dock"]'), mq: document.querySelector('[data-testid="music-queue"]')?.textContent, w: document.querySelectorAll('[data-action="watch"]').length }))); }
      ok(has, `X6 ${width}: the watch panel shows the queue`);
      const skip = !!(await page.$('[data-action="queue-skip"]'));
      ok(width === 1366 ? skip : !skip, `X6 ${width}: skip only for the owner / DJ`);
      if (width === 390) {
        await page.type('[data-field="queue-link"]', yt(9)); await page.$eval('[data-action="queue-add"]', (b) => b.click());
        ok(await page.waitForSelector(`[data-queue-item="${vid(9)}"]`, { timeout: 4000 }).then(() => true, () => false), 'X6 390: queue a link from the panel');
      }
      await page.$eval('[data-testid="music-queue"]', (e) => e.scrollIntoView({ block: 'center' }));
      const fits = await page.$eval('[data-testid="music-queue"]', (e) => e.getBoundingClientRect().right <= innerWidth + 1 && e.scrollWidth <= e.clientWidth + 1);
      ok(fits, `X6 ${width}: queue fits the width`);
      await shot(page, `x-music-queue-${width}`);
      await ctx.close();
    }
    await emit(D.s, 'watch:update', { action: 'clear' });
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM }); await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM });
  }
