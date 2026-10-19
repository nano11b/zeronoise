  // @@X3 chat commands
  if (want('X3')) {
    const ev = events(E.s, 'chat:message');
    const last = () => ev[ev.length - 1]?.text ?? '';
    const say = async (t) => { await sleep(700); const n = ev.length; const r = await emit(D.s, 'chat:send', { text: t }); if (r.ok === false) console.log('[say]', t, r.error); await waitFor(() => ev.length > n, 2000); return r; };
    await say('/me waves *hi*');
    ok(last() === `_${D.nick} waves \\*hi\\*_`, `X3: /me posts an action line (${last()})`);
    await say('/shrug ok');
    ok(last() === 'ok ¯\\\\\\_(ツ)\\_/¯', `X3: /shrug (${last()})`);
    await say('/roll 3d6');
    const m = /^🎲 rolled 3d6: (\d+) \+ (\d+) \+ (\d+) = \*\*(\d+)\*\*$/.exec(last());
    ok(m && [1, 2, 3].every((i) => +m[i] >= 1 && +m[i] <= 6) && +m[4] === +m[1] + +m[2] + +m[3], `X3: /roll 3d6 (${last()})`);
    await say('/roll'); ok(/^🎲 rolled 1d6: \*\*[1-6]\*\*$/.test(last()), 'X3: /roll defaults to 1d6');
    for (const bad of ['/roll 50d6', '/roll 2d1', '/roll 2d99999', '/roll abc', '/me']) ok((await emit(D.s, 'chat:send', { text: bad })).ok === false, `X3: refused: ${bad}`);
    await sleep(3000); const flips = new Set(); for (let i = 0; i < 14; i++) { const r = await say('/flip'); if (r.ok !== false) flips.add(last()); await sleep(900); if (flips.size === 2) break; }
    ok([...flips].every((t) => /^🪙 flipped a coin: \*\*(heads|tails)\*\*$/.test(t)) && flips.size === 2, 'X3: /flip gives heads or tails');
    await say('/notacommand hello'); ok(last() === '/notacommand hello', 'X3: unknown /words are posted as typed');
    // custom commands
    const base = `/api/rooms/${encodeURIComponent(ROOM)}/commands`;
    ok((await E.j.req(`${base}/rules`, { response: 'x' }, 'PUT')).status === 403, 'X3: only the owner can add commands');
    const c1 = await D.j.req(`${base}/rules`, { response: 'Be kind <script>alert(1)</script> @everyone' }, 'PUT');
    const saved = c1.commands?.find((c) => c.name === 'rules')?.response ?? '';
    ok(c1.ok && !/[<>]/.test(saved) && !/@everyone\b/.test(saved) && saved.includes('＠everyone'), `X3: replies are sanitized (${saved})`);
    for (const [n, body, why] of [['roll', { response: 'x' }, 'reserved name'], ['a', { response: 'x' }, 'too short name'], ['bad name', { response: 'x' }, 'bad name'], ['long', { response: 'x'.repeat(301) }, 'too long reply'], ['empty', { response: '   ' }, 'empty reply']])
      ok((await D.j.req(`${base}/${encodeURIComponent(n)}`, body, 'PUT')).status === 400, `X3: refused: ${why}`);
    for (let i = 0; i < 19; i++) await D.j.req(`${base}/c${i}x`, { response: `r${i}` }, 'PUT');
    ok((await D.j.req(`${base}/onemore`, { response: 'x' }, 'PUT')).status === 400, 'X3: at most 20 commands per room');
    await D.j.req(`${base}/c18x`, undefined, 'DELETE');
    ok(!(await E.j.req(base)).commands.some((c) => c.name === 'c18x'), 'X3: owner removes a command');
    await say('/rules'); ok(last() === saved, 'X3: typing /rules posts the reply');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      await page.focus('input[aria-label="Chat message"]'); await page.keyboard.type('/r');
      await page.waitForSelector('[data-testid="cmd-hints"]', { timeout: 4000 }).catch(() => {});
      const hints = await page.$$eval('[data-testid="cmd-hints"] [data-cmd]', (x) => x.map((b) => b.dataset.cmd));
      ok(hints.includes('roll') && hints.includes('rules'), `X3 ${width}: typing "/" suggests built-in and room commands (${hints})`);
      await shot(page, `x-commands-hints-${width}`);
      await page.$eval('[data-cmd="roll"]', (b) => b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); await sleep(150);
      await page.keyboard.type('2d20'); await page.keyboard.press('Enter'); await sleep(700);
      ok(await page.evaluate(() => [...document.querySelectorAll('.chat-log .md')].some((e) => /🎲 rolled 2d20/.test(e.textContent))), `X3 ${width}: /roll from the message box posts the result`);
      await shot(page, `x-commands-chat-${width}`);
      const has = await openSettings(page, width, 'commands');
      if (has) { await page.waitForSelector('[data-panel="commands"] [data-command="rules"]', { timeout: 5000 }).catch(() => {}); }
      ok(has && !!(await page.$('[data-panel="commands"] [data-command="rules"]')), `X3 ${width}: room settings list the commands`);
      if (has) await shot(page, `x-commands-settings-${width}`);
      await ctx.close();
    }
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
