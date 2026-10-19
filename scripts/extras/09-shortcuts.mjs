  // @@X9 keyboard shortcuts
  if (want('X9')) {
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.type('?');
      const open = await page.waitForSelector('[data-testid="shortcuts"]', { timeout: 4000 }).then(() => true, () => false);
      ok(open, `X9 ${width}: "?" opens the shortcuts panel`);
      ok(open && (await page.$$eval('[data-testid="shortcuts"] kbd', (x) => x.length)) >= 8, `X9 ${width}: the panel lists the keys`);
      await shot(page, `x-shortcuts-${width}`);
      await page.keyboard.press('Escape'); await sleep(300);
      ok(!(await page.$('[data-testid="shortcuts"]')), `X9 ${width}: Esc closes it`);
      if (width === 1366) {
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.type('/'); await sleep(200);
        ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Chat message'), 'X9: "/" focuses the message box');
        await page.keyboard.type('?'); await sleep(300);
        ok(!(await page.$('[data-testid="shortcuts"]')) && (await page.$eval('input[aria-label="Chat message"]', (i) => i.value)) === '?', 'X9: typing "?" in the message box just types it');
        await setVal(page, 'input[aria-label="Chat message"]', '');
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.click('[data-action="profile"]'); await page.waitForSelector('[data-action="open-shortcuts"]', { timeout: 4000 }).catch(() => {});
        await page.$eval('[data-action="open-shortcuts"]', (b) => b.click()).catch(() => {});
        ok(await page.waitForSelector('[data-testid="shortcuts"]', { timeout: 4000 }).then(() => true, () => false), 'X9: also opens from the Your profile menu');
        await page.$eval('[data-field="single-key-off"]', (c) => c.click()); await page.keyboard.press('Escape'); await sleep(300);
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.type('?'); await sleep(400);
        ok(!(await page.$('[data-testid="shortcuts"]')), 'X9: single-key shortcuts can be turned off');
        await page.evaluate(() => localStorage.removeItem('zn.singleKeyShortcutsOff'));
      }
      await ctx.close();
    }
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
