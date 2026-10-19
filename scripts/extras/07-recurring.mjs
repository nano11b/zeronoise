  // @@X7 recurring events
  if (want('X7')) {
    const EV = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/events.js')).href);
    const ny = (s) => new Date(s).getTime();
    const fmtNY = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(t);
    ok(fmtNY(EV.nextOccurrence(ny('2026-10-31T23:00:00Z'), 'weekly', 'America/New_York')) === '11/7/26, 7:00 PM', 'X7: weekly keeps 7 PM across the DST change');
    ok(fmtNY(EV.nextOccurrence(ny('2027-01-31T15:00:00Z'), 'monthly', 'America/New_York')) === '2/28/27, 10:00 AM', 'X7: monthly on the 31st falls back to the month end');
    ok(fmtNY(EV.nextOccurrence(ny('2027-02-28T15:00:00Z'), 'monthly', 'America/New_York', 31)) === '3/31/27, 10:00 AM', 'X7: monthly returns to the anchor day');
    ok(EV.nextOccurrence(ny('2026-10-20T12:00:00Z'), 'biweekly', 'UTC') === ny('2026-11-03T12:00:00Z') && EV.nextOccurrence(ny('2026-10-20T12:00:00Z'), 'daily', 'UTC') === ny('2026-10-21T12:00:00Z'), 'X7: daily and every-2-weeks');
    const list = async (u) => (await emit(u.s, 'events:list')).events ?? [];
    const base = { title: 'Game night', description: 'weekly', durationMin: 30, recurTz: 'America/New_York' };
    for (const [bad, why] of [[{ recur: 'yearly' }, 'unknown repeat'], [{ recur: 'weekly', recurTz: 'Mars/Base' }, 'bad time zone'], [{ recur: 'weekly', recurUntil: Date.now() }, 'end before start']])
      ok((await emit(D.s, 'events:create', { ...base, startsAt: Date.now() + 3600_000, ...bad })).ok === false, `X7: refused: ${why}`);
    ok((await emit(E.s, 'events:create', { ...base, startsAt: Date.now() + 3600_000, recur: 'weekly' })).ok === false, 'X7: members cannot schedule');
    const start = Date.now() + 2500;
    const c = await emit(D.s, 'events:create', { ...base, startsAt: start, recur: 'weekly' });
    ok(c.ok && c.event.recur === 'weekly' && c.event.recurUntil > start, 'X7: owner schedules a weekly event');
    await emit(E.s, 'events:rsvp', { id: c.event.id, status: 'going' });
    const rem = events(E.s, 'event:reminder');
    await waitFor(() => rem.some((r) => r.eventId === c.event.id && r.stage === 'start'), 8000);
    ok(rem.some((r) => r.eventId === c.event.id && r.stage === 'start'), 'X7: RSVPed people get the start reminder');
    await sleep(800);
    const evs = (await list(E)).filter((e) => e.title === 'Game night');
    const nxt = evs.find((e) => e.id !== c.event.id);
    ok(nxt && fmtNY(nxt.startsAt) === fmtNY(EV.nextOccurrence(c.event.startsAt, 'weekly', 'America/New_York')) && nxt.recur === 'weekly', `X7: the next week's date is scheduled when it starts (${nxt && fmtNY(nxt.startsAt)})`);
    ok(nxt?.myRsvp === 'going' && nxt.going === 1, 'X7: RSVPs carry over to the next date');
    await sleep(500); const again = (await list(E)).filter((e) => e.title === 'Game night').length;
    ok(again === evs.length, 'X7: only one next date is created');
    const sk = await emit(D.s, 'events:cancel', { id: nxt.id, scope: 'occurrence' });
    const after = (await list(D)).filter((e) => e.title === 'Game night' && e.id !== c.event.id);
    ok(sk.ok && after.length === 1 && after[0].id !== nxt.id && after[0].startsAt > nxt.startsAt && after[0].myRsvp === undefined && after[0].going === 1, 'X7: "skip this date" schedules the following one and keeps RSVPs');
    ok((await emit(D.s, 'events:cancel', { id: after[0].id, scope: 'series' })).ok && !(await list(D)).some((e) => e.title === 'Game night' && e.startsAt > Date.now()), 'X7: "end series" stops it');
    const lim = await emit(D.s, 'events:create', { ...base, title: 'Until test', startsAt: Date.now() + 2000, recur: 'daily', recurUntil: Date.now() + 3 * 3600_000 });
    await sleep(3500);
    ok(lim.ok && !(await list(D)).some((e) => e.title === 'Until test' && e.id !== lim.event.id), 'X7: no new date past the "until" day');
    const show = await emit(D.s, 'events:create', { ...base, title: 'Movie night', startsAt: Date.now() + 2 * 86400_000, recur: 'biweekly', durationMin: 120 });
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      if (width < 800) { await page.$eval('[data-action="collapse-panel"]', (b) => b.click()).catch(() => {}); await sleep(400); }
      await page.$eval('[data-action="tab-events"]', (b) => b.click()).catch(() => {});
      const has = await page.waitForSelector(`[data-event="${show.event.id}"] [data-recur="biweekly"]`, { timeout: 6000 }).then(() => true, () => false);
      ok(has && !!(await page.$(`[data-event="${show.event.id}"] [data-action="event-skip"]`)), `X7 ${width}: the list shows the repeat and "Skip this date"`);
      await shot(page, `x-recurring-list-${width}`);
      await page.$eval('[data-action="event-new"]', (b) => b.click()).catch(() => {});
      await page.waitForSelector('[data-field="recur"]', { timeout: 4000 }).catch(() => {});
      await page.select('[data-field="recur"]', 'weekly').catch(() => {}); await sleep(200);
      ok(!!(await page.$('[data-field="recur-until"]')), `X7 ${width}: the form has Repeats and Until`);
      await page.$eval('[data-field="recur"]', (e) => e.scrollIntoView({ block: 'center' }));
      await shot(page, `x-recurring-form-${width}`);
      await ctx.close();
    }
    await emit(D.s, 'events:cancel', { id: show.event.id });
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
