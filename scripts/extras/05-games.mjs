  // @@X5 room games
  if (want('X5')) {
    const gst = events(E.s, 'game:state');
    const act = async (u, p) => { await sleep(120); return emit(u.s, 'game:act', p); };
    const lastG = () => gst[gst.length - 1];
    // tic-tac-toe: D (X) vs E (O); S watches
    ok((await act(D, { game: 'ttt', action: 'open' })).ok, 'X5: open a tic-tac-toe table');
    ok((await act(D, { game: 'ttt', action: 'open' })).ok === false, 'X5: one table per room');
    ok((await act(D, { game: 'ttt', action: 'join' })).ok === false, 'X5: cannot play yourself');
    ok((await act(E, { game: 'ttt', action: 'join' })).ok, 'X5: a second player joins');
    ok((await act(S, { game: 'ttt', action: 'join' })).ok === false, 'X5: a third person only watches');
    await waitFor(() => lastG()?.ttt?.o, 2000);
    const gid = lastG().ttt.id;
    ok((await act(E, { game: 'ttt', action: 'move', cell: 0, gameId: gid })).ok === false, 'X5: O cannot move on X\'s turn');
    ok((await act(S, { game: 'ttt', action: 'move', cell: 0, gameId: gid })).ok === false, 'X5: watchers cannot move');
    for (const [u, c] of [[D, 0], [E, 3], [D, 1], [E, 4]]) await act(u, { game: 'ttt', action: 'move', cell: c, gameId: gid });
    ok((await act(E, { game: 'ttt', action: 'move', cell: 0, gameId: gid })).ok === false, 'X5: taken squares are refused');
    await act(D, { game: 'ttt', action: 'move', cell: 2, gameId: gid });
    await waitFor(() => lastG()?.ttt?.winner, 2000);
    ok(lastG().ttt.winner === 'X' && lastG().ttt.line?.join() === '0,1,2', 'X5: three in a row wins');
    // word chain
    ok((await act(D, { game: 'chain', action: 'start' })).ok, 'X5: start a word chain');
    ok((await act(D, { game: 'chain', action: 'play', word: 'apple' })).ok, 'X5: first word');
    ok((await act(D, { game: 'chain', action: 'play', word: 'egg' })).ok === false, 'X5: same player twice in a row is refused');
    ok((await act(E, { game: 'chain', action: 'play', word: 'banana' })).ok === false, 'X5: wrong first letter is refused');
    ok((await act(E, { game: 'chain', action: 'play', word: 'e1' })).ok === false, 'X5: non-words are refused');
    ok((await act(E, { game: 'chain', action: 'play', word: 'elephant' })).ok, 'X5: a matching word scores');
    ok((await act(D, { game: 'chain', action: 'play', word: 'tiger' })).ok, 'X5: chain continues');
    ok((await act(E, { game: 'chain', action: 'play', word: 'rabbit' })).ok, 'X5: chain continues (2)');
    ok((await act(D, { game: 'chain', action: 'play', word: 'tiger' })).ok === false, 'X5: repeated words are refused');
    ok((await act(S, { game: 'chain', action: 'stop' })).ok, 'X5: staff stop the round');
    // rate limit
    let limited2 = false; for (let i = 0; i < 12; i++) { const r = await emit(E.s, 'game:act', { game: 'chain', action: 'play', word: 'zzz' }); if (/slow down/i.test(r.error ?? '')) { limited2 = true; break; } }
    ok(limited2, 'X5: game actions are rate limited');
    await sleep(3200);
    const g = await emit(D.s, 'game:get');
    const tttTop = g.boards?.ttt ?? []; const chainTop = g.boards?.chain ?? [];
    ok(tttTop[0]?.name === D.nick && tttTop[0].wins === 1 && tttTop[0].points === 3 && tttTop.find((r) => r.name === E.nick)?.played === 1, `X5: tic-tac-toe leaderboard (${JSON.stringify(tttTop)})`);
    ok(chainTop[0]?.name === E.nick && chainTop[0].points === 6 + 4 && chainTop.find((r) => r.name === D.nick)?.points === 3 + 3, `X5: word-chain leaderboard (${JSON.stringify(chainTop)})`);
    ok(Array.isArray(g.boards?.trivia), 'X5: trivia board is included');
    // UI: D opens a new table; E sees it at 390
    await act(D, { game: 'ttt', action: 'open' });
    await act(D, { game: 'chain', action: 'start' }); await act(E, { game: 'chain', action: 'play', word: 'house' });
    for (const [u, width] of [[D, 1366], [E, 390]]) {
      const { ctx, page } = await pageFor(u, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      await page.$eval('[data-action="more"]', (b) => b.click()).catch(() => {}); await sleep(300);
      await page.$eval('[data-action="games"]', (b) => b.click()).catch(() => {});
      await page.waitForSelector('[data-tab="room-games"]', { timeout: 8000 }).catch(() => {});
      await page.$eval('[data-tab="room-games"]', (b) => b.click()).catch(() => {});
      const panel = await page.waitForSelector('[data-testid="room-games"] [data-testid="chain-status"]', { timeout: 6000 }).then(() => true, () => false);
      ok(panel, `X5 ${width}: Games ▸ Room games shows the live games`);
      if (width === 390) {
        await page.$eval('[data-action="ttt-join"]', (b) => b.click()).catch(() => {}); await sleep(600);
        ok(/vs .*\(O\)/.test(await page.$eval('[data-testid="ttt-status"]', (e) => e.textContent).catch(() => '')) && !(await page.$('[data-action="ttt-join"]')), 'X5 390: join from the panel');
        await page.type('[data-field="chain-word"]', 'egg'); await page.keyboard.press('Enter'); await sleep(600);
        ok((await page.$$eval('[data-testid="chain-words"] li b', (x) => x.map((e) => e.textContent))).includes('egg') === false, 'X5 390: own consecutive word refused in the UI');
      } else {
        await page.$eval('[data-board="chain"]', (b) => b.click()).catch(() => {}); await sleep(300);
        ok(await page.$(`[data-testid="game-board"] [data-board-row="${E.nick}"]`), 'X5 1366: leaderboard tab lists players');
      }
      const fits = await page.$eval('[data-testid="room-games"]', (e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= innerWidth + 1).catch(() => false);
      ok(fits, `X5 ${width}: panel fits the width`);
      await shot(page, `x-games-${width}`);
      await ctx.close();
    }
    await act(S, { game: 'chain', action: 'stop' }); await act(S, { game: 'ttt', action: 'end' });
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM }); await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM });
  }
