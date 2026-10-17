// Real-browser WebRTC test using fake camera/mic. Requires a running server + Chrome/Chromium.
// CHROME_PATH=/usr/bin/google-chrome node scripts/browser-test.mjs [url] [screenshot.png] [admin-screenshot.png]
// Alice, Bob and Carol each register (email required). Alice and Bob publish cam and mic; Carol watches.
// Optional: ADMIN_USERNAME=<name listed in the server's ADMIN_USERNAMES> adds a moderator pass
// (force cam off from the user menu) and screenshots the admin panel.
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] || 'http://localhost:3000';
const SHOT = process.argv[3] || 'camchat-screenshot.png';
const ADMIN_SHOT = process.argv[4] || 'camchat-admin.png';
const ADMIN = process.env.ADMIN_USERNAME;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let passed = 0, failed = 0;
const ok = (c, n) => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const tag = Date.now().toString(36).slice(-4);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    // headless boxes can't resolve mDNS-obfuscated host candidates
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function user(nick, join = true) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 820 });
  // FORCE_RELAY=1: only TURN relay candidates (proves the TURN server + credentials work)
  await page.evaluateOnNewDocument(() => {
    const Orig = RTCPeerConnection;
    const pcs = [];
    window.__pcs = pcs;
    window.RTCPeerConnection = new Proxy(Orig, {
      construct(target, args) {
        const pc = new target(...args);
        pcs.push(pc);
        return pc;
      },
    });
  });
  if (process.env.FORCE_RELAY === '1') await page.evaluateOnNewDocument(() => localStorage.setItem('camchat.relay', '1'));
  page.on('pageerror', (e) => console.log(`[${nick} pageerror]`, e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.click('[data-tab="register"]');
  page.__loginProbe = await page.evaluate(() => ({
    guestTab: !!document.querySelector('[data-tab="guest"]'),
    email: !!document.querySelector('[data-testid="register-email"]'),
    noEmailNeeded: /No email needed/i.test(document.body.innerText),
  }));
  await page.type('input[name="username"]', nick);
  await page.type('input[name="email"]', `${nick.toLowerCase()}@example.com`);
  await page.type('input[name="password"]', `pw-${nick}-secret`);
  await page.type('input[name="password2"]', `pw-${nick}-secret`);
  const cap = await page.$('input[name="captcha"]');
  if (cap) {
    const m = /What is (\d+) \+ (\d+)/.exec(await page.evaluate(() => {
      const lab = [...document.querySelectorAll('label.field')].find((l) => /CAPTCHA/.test(l.textContent || ''));
      return lab?.textContent || '';
    }));
    if (m) await cap.type(String(+m[1] + +m[2]));
  }
  await page.evaluate(() => document.querySelector('[data-action="account-submit"]')?.scrollIntoView({ block: 'center' }));
  await page.click('[data-action="account-submit"]');
  const err = await page.waitForSelector('.form-error', { timeout: 1500 }).then((e) => e.evaluate((x) => x.textContent), () => null);
  if (err && !/already registered/.test(err)) throw new Error(`register ${nick}: ${err}`);
  if (err && /already registered/.test(err)) {
    await page.click('[data-tab="signin"]');
    await page.type('input[name="username"]', nick);
    await page.type('input[name="password"]', `pw-${nick}-secret`);
    await page.click('[data-action="account-submit"]');
  }
  await page.waitForSelector('.room-card[data-room="lobby"]');
  if (!join) return page;
  await page.click('.room-card[data-room="lobby"]');
  await page.waitForSelector('.chat-form input');
  return page;
}
const remoteVideoReady = (page, nick) =>
  page.waitForFunction((n) => {
    const v = document.querySelector(`.tile[data-user="${n}"] video`);
    return v && v.videoWidth > 0 && v.srcObject && v.srcObject.getVideoTracks().length > 0 && !v.paused;
  }, { timeout: 20000 }, nick).then(() => true, () => false);

try {
  const alice = await user(`Alice_${tag}`);
  const bob = await user(`Bob_${tag}`);
  const carol = await user(`Carol_${tag}`);
  ok(alice.__loginProbe && !alice.__loginProbe.guestTab && alice.__loginProbe.email && !alice.__loginProbe.noEmailNeeded, 'register asks for an email and has no guest nickname');
  await carol.waitForSelector(`.user-row[data-nick="Alice_${tag}"]`);
  ok(!(await carol.$(`.user-row[data-nick="Alice_${tag}"] .role-guest`)) && !(await alice.$(`.user-row[data-nick="Carol_${tag}"] .role-guest`)),
    'registered users are not shown as guests');

  await alice.waitForSelector('[data-action="cam"]:not([disabled])');
  await alice.click('[data-action="cam"]');
  await alice.waitForSelector('[data-action="cam"].on');
  await alice.waitForSelector('[data-action="mic"]:not([disabled])');
  await alice.click('[data-action="mic"]');
  await alice.waitForSelector('[data-action="mic"].on');
  await bob.waitForSelector('[data-action="cam"]:not([disabled])');
  await bob.click('[data-action="cam"]');
  await bob.waitForSelector('[data-action="cam"].on');

  ok(await remoteVideoReady(bob, `Alice_${tag}`), 'Bob receives and plays Alice\'s camera over WebRTC');
  ok(await remoteVideoReady(alice, `Bob_${tag}`), 'Alice receives and plays Bob\'s camera over WebRTC');
  ok(await remoteVideoReady(carol, `Alice_${tag}`), 'Carol (viewer only) receives Alice\'s camera');
  ok(await remoteVideoReady(carol, `Bob_${tag}`), 'Carol (viewer only) receives Bob\'s camera');
  await bob.waitForSelector('[data-action="mic"]:not([disabled])');
  await bob.click('[data-action="mic"]');
  await bob.waitForSelector('[data-action="mic"].on');
  const hasAudio = await bob.evaluate((n) => document.querySelector(`.tile[data-user="${n}"] video`).srcObject.getAudioTracks().length, `Alice_${tag}`);
  const bobAudio = await alice.waitForFunction((n) => {
    const v = document.querySelector(`.tile[data-user="${n}"] video`);
    return v && v.srcObject && v.srcObject.getAudioTracks().length > 0;
  }, { timeout: 8000 }, `Bob_${tag}`).then(() => true, () => false);
  ok(hasAudio === 1 && bobAudio, 'mic tracks arrive both ways');
  const levelOf = (page) => page.evaluate(async () => {
    let best = 0;
    for (const pc of window.__pcs || []) {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number') best = Math.max(best, s.audioLevel);
      });
    }
    return best;
  });
  // batch H9: under load the audio pipeline can take a few seconds to start after unmuting, so poll
  // (up to 10 s) instead of taking one sample 600 ms in.
  let aliceLevel = 0; let bobLevel = 0;
  for (const until = Date.now() + 10_000; Date.now() < until && !(aliceLevel > 0.01 && bobLevel > 0.01);) {
    await new Promise((r) => setTimeout(r, 400));
    aliceLevel = Math.max(aliceLevel, await levelOf(bob));
    bobLevel = Math.max(bobLevel, await levelOf(alice));
  }
  ok(aliceLevel > 0.01 && bobLevel > 0.01, `audio both ways (Alice at Bob audioLevel ${aliceLevel.toFixed(3)}, Bob at Alice audioLevel ${bobLevel.toFixed(3)})`);

  // Remote tiles must stay mounted when the Cams pane is hidden, or voice stops.
  const mediaState = (page) => page.evaluate(() => {
    const vids = [...document.querySelectorAll('.tile video')];
    vids.forEach((v, i) => { if (!v.dataset.keep) v.dataset.keep = `m${i}`; });
    if (!window.__negoWatch) {
      window.__nego = 0;
      window.__negoWatch = true;
      for (const pc of window.__pcs || []) {
        pc.addEventListener('signalingstatechange', () => { if (pc.signalingState !== 'stable') window.__nego++; });
      }
    }
    return {
      ids: vids.map((v) => v.dataset.keep).join(','),
      n: vids.length,
      playing: vids.filter((v) => v.srcObject && !v.paused && v.videoWidth > 0 && v.readyState >= 2).length,
      time: vids.reduce((sum, v) => sum + (v.currentTime || 0), 0),
      pcs: (window.__pcs || []).length,
      nego: window.__nego || 0,
    };
  });
  const holdMedia = async (page, before, name) => {
    await new Promise((r) => setTimeout(r, 450));
    const after = await mediaState(page);
    ok(after.n === before.n && after.n > 0 && after.ids === before.ids, `${name}: media elements stay mounted (${before.ids || 'none'} -> ${after.ids || 'none'})`);
    ok(after.playing === before.playing && after.playing > 0, `${name}: media keeps playing (${after.playing}/${after.n})`);
    ok(after.time > before.time + 0.15, `${name}: playback keeps advancing (${before.time.toFixed(2)} -> ${after.time.toFixed(2)})`);
    // Count negotiation attempts across the switch. Do not require signalingState stable:
    // some environments never settle, and a stuck connection is not a new negotiation.
    ok(after.pcs === before.pcs && after.nego === before.nego, `${name}: no renegotiation (${before.nego} -> ${after.nego})`);
    return after;
  };
  let held = await mediaState(bob);
  const stripBox = await bob.evaluate(() => {
    const strip = document.querySelector('.media-strip')?.getBoundingClientRect();
    const chat = document.querySelector('.chat-stage')?.getBoundingClientRect();
    return {
      open: document.querySelector('[data-media-strip="open"]') != null,
      above: !!strip && !!chat && strip.bottom <= chat.top + 2 && strip.height > 80,
      camsTab: !!document.querySelector('[data-action="tab-cams"]'),
      camsNav: !!document.querySelector('[data-action="nav-cams"]'),
    };
  });
  ok(stripBox.open && stripBox.above && !stripBox.camsTab && !stripBox.camsNav, `cameras sit in a strip above the chat (${JSON.stringify(stripBox)})`);
  await bob.click('[data-action="toggle-strip"]');
  await bob.waitForFunction(() => document.querySelector('[data-media-strip="collapsed"]')?.hasAttribute('inert'));
  held = await holdMedia(bob, held, 'desktop strip collapsed');
  await bob.click('[data-action="toggle-strip"]');
  await bob.waitForFunction(() => document.querySelector('[data-media-strip="open"]') && !document.querySelector('.media-strip')?.hasAttribute('inert'));
  held = await holdMedia(bob, held, 'desktop strip expanded');
  await bob.click('[data-action="tab-rooms"]');
  held = await holdMedia(bob, held, 'desktop rooms tab');
  await bob.click('[data-action="tab-info"]');
  held = await holdMedia(bob, held, 'desktop room info tab');
  await bob.click('[data-action="collapse-panel"]');
  held = await holdMedia(bob, held, 'desktop panel collapsed');
  await bob.click('[data-action="collapse-panel"]');
  await bob.click('[data-action="tab-rooms"]');
  held = await holdMedia(bob, held, 'desktop rooms tab restored');
  await bob.setViewport({ width: 390, height: 844 });
  held = await holdMedia(bob, held, 'phone strip visible');
  const phoneStrip = await bob.evaluate(() => {
    const strip = document.querySelector('.media-strip')?.getBoundingClientRect();
    const chat = document.querySelector('.chat-stage')?.getBoundingClientRect();
    return {
      h: strip?.height ?? 0,
      vh: window.innerHeight,
      above: !!strip && !!chat && strip.bottom <= chat.top + 2,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      room: document.querySelector('.room-body')?.scrollLeft || 0,
    };
  });
  ok(phoneStrip.above && phoneStrip.h > 80 && phoneStrip.h <= phoneStrip.vh * 0.42 && phoneStrip.overflow <= 0 && phoneStrip.room === 0,
    `phone strip stays above the chat within 40% of the screen (${JSON.stringify(phoneStrip)})`);
  await bob.waitForFunction(() => document.querySelector('.side-panel')?.hasAttribute('inert'));
  const closedScroll = await bob.evaluate(() => {
    document.querySelector('.side-panel [data-action="tab-rooms"]')?.focus();
    const chat = document.querySelector('.chat-stage')?.getBoundingClientRect();
    return {
      doc: document.scrollingElement?.scrollLeft || 0,
      room: document.querySelector('.room-body')?.scrollLeft || 0,
      chatX: chat?.x ?? -1,
      chatW: chat?.width ?? 0,
      vw: window.innerWidth,
    };
  });
  ok(closedScroll.doc === 0 && closedScroll.room === 0 && closedScroll.chatX >= 0 && closedScroll.chatX <= 16 && closedScroll.chatW >= closedScroll.vw - 32 && closedScroll.chatW <= closedScroll.vw,
    `phone closed drawer focus keeps the chat in place (${JSON.stringify(closedScroll)})`);
  await bob.click('[data-action="collapse-panel"]');
  await bob.waitForFunction(() => document.querySelector('.room.shell')?.classList.contains('panel-open'));
  held = await holdMedia(bob, held, 'phone drawer open');
  await bob.click('[data-action="tab-rooms"]');
  held = await holdMedia(bob, held, 'phone rooms tab');
  await bob.click('[data-action="tab-info"]');
  held = await holdMedia(bob, held, 'phone room info tab');
  await bob.evaluate(() => document.querySelector('.drawer-backdrop')?.click());
  await bob.waitForFunction(() => !document.querySelector('.room.shell')?.classList.contains('panel-open'));
  held = await holdMedia(bob, held, 'phone drawer closed');
  await bob.click('[data-action="toggle-strip"]');
  await bob.waitForFunction(() => document.querySelector('[data-media-strip="collapsed"]')?.hasAttribute('inert'));
  held = await holdMedia(bob, held, 'phone strip collapsed');
  const stripScroll = await bob.evaluate(() => {
    document.querySelector('.media-strip video')?.focus();
    const chat = document.querySelector('.chat-stage')?.getBoundingClientRect();
    const strip = document.querySelector('.media-strip')?.getBoundingClientRect();
    return {
      doc: document.scrollingElement?.scrollLeft || 0,
      room: document.querySelector('.room-body')?.scrollLeft || 0,
      chatX: chat?.x ?? -1,
      chatW: chat?.width ?? 0,
      vw: window.innerWidth,
      stripH: strip?.height ?? -1,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok(stripScroll.doc === 0 && stripScroll.room === 0 && stripScroll.overflow <= 0 && stripScroll.stripH <= 2
    && stripScroll.chatX >= 0 && stripScroll.chatX <= 16 && stripScroll.chatW >= stripScroll.vw - 32 && stripScroll.chatW <= stripScroll.vw,
    `phone collapsed strip does not scroll the chat (${JSON.stringify(stripScroll)})`);
  await bob.click('[data-action="toggle-strip"]');
  await bob.waitForFunction(() => document.querySelector('[data-media-strip="open"]'));
  held = await holdMedia(bob, held, 'phone strip expanded');
  await bob.setViewport({ width: 1366, height: 820 });
  await bob.waitForFunction(() => {
    const panel = document.querySelector('.side-panel');
    return !!panel && !panel.hasAttribute('inert') && !panel.hasAttribute('hidden');
  });
  await bob.waitForSelector('[data-media-strip="open"] .tile video');

  // chat + HTML escaping in the real UI
  await alice.type('.chat-form input', 'hi everyone <img src=x onerror="window.__xss=1">');
  await alice.keyboard.press('Enter');
  await bob.waitForFunction(() => [...document.querySelectorAll('.msg .text')].some((e) => e.textContent.includes('<img')), { timeout: 5000 });
  ok(await bob.evaluate(() => !window.__xss && !document.querySelector('.chat-log img')), 'HTML in chat is shown as text, not executed');
  await carol.type('.chat-form input', 'nice cams!');
  await carol.keyboard.press('Enter');
  await bob.type('.chat-form input', 'hey Alice, video looks great');
  await bob.keyboard.press('Enter');

  const userList = await bob.$$eval('.users .user', (els) => els.map((e) => e.textContent));
  ok(userList.some((t) => t.includes(`Alice_${tag}`) && t.includes('cam') && t.includes('mic')), 'user list shows Alice on cam and mic');

  // local mute toggle (the tile also has watch/unwatch; use the mute control)
  await bob.click(`.tile[data-user="Alice_${tag}"] [data-action="mute"]`);
  ok(await bob.evaluate((n) => document.querySelector(`.tile[data-user="${n}"] video`).muted, `Alice_${tag}`), 'Bob can locally mute Alice');
  await bob.click(`.tile[data-user="Alice_${tag}"] [data-action="unmute"]`);

  // click to enlarge
  await bob.click(`.tile[data-user="Alice_${tag}"]`);
  ok(!!(await bob.$(`.tile.big[data-user="Alice_${tag}"]`)), 'clicking a tile enlarges it');
  await bob.click(`.tile[data-user="Alice_${tag}"]`);

  // cam off propagates
  await alice.click('[data-action="cam"]');
  await bob.waitForFunction((n) => document.querySelector(`.tile[data-user="${n}"]`)?.classList.contains('audio-only'), { timeout: 5000 }, `Alice_${tag}`).catch(() => {});
  ok(await bob.evaluate((n) => document.querySelector(`.tile[data-user="${n}"]`)?.classList.contains('audio-only'), `Alice_${tag}`), 'Alice turning cam off shows her as audio-only for Bob');
  await alice.click('[data-action="cam"]');
  await alice.waitForSelector('[data-action="cam"].on');
  ok(await remoteVideoReady(bob, `Alice_${tag}`), 'Alice re-enabling cam resumes video for Bob');
  await new Promise((r) => setTimeout(r, 1500)); // let fake video render frames

  await bob.screenshot({ path: SHOT });
  console.log(`screenshot -> ${SHOT}`);

  // report a message through the UI (Carol reports Bob's message)
  const bobMsg = await carol.waitForFunction(() => [...document.querySelectorAll('.msg[data-msg]')].find((m) => m.textContent.includes('video looks great'))?.dataset.msg, { timeout: 5000 }).then((h) => h.jsonValue());
  await carol.hover(`.msg[data-msg="${bobMsg}"]`);
  await carol.click(`.msg[data-msg="${bobMsg}"] [data-action="report-msg"]`);
  await carol.waitForSelector('[data-testid="report-dialog"]');
  await carol.$eval('[data-testid="report-dialog"] input[name="report-category"]', (e) => e.click());
  await carol.type('.modal textarea', 'testing the report button');
  await carol.click('[data-action="report-submit"]');
  ok(await carol.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Report sent')), { timeout: 5000 }).then(() => true, () => false), 'Carol reports a message from the chat');

  if (ADMIN) {
    const admin = await user(ADMIN, false);
    ok(!!(await admin.$('[data-action="admin"]')), `admin ${ADMIN} sees the Mod panel button`);
    await admin.click('.room-card[data-room="lobby"]');
    await admin.waitForSelector('.chat-form input');
    await admin.click(`.user-row[data-nick="Bob_${tag}"]`);
    await admin.click('[data-action="camoff"]');
    const off = await bob.waitForFunction(() => !document.querySelector('[data-action="cam"].on'), { timeout: 5000 }).then(() => true, () => false);
    ok(off, 'moderator turns Bob\'s cam off from the user menu; Bob\'s camera stops');
    await bob.click('[data-action="cam"]');
    ok(await bob.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /moderator/i.test(t.textContent)), { timeout: 5000 }).then(() => true, () => false), 'Bob cannot restart his cam during the block');
    // mod panel
    await admin.goto(`${URL}/admin`, { waitUntil: 'networkidle0' });
    await admin.waitForSelector('.report', { timeout: 5000 }).catch(() => {});
    ok(await admin.evaluate(() => [...document.querySelectorAll('.report')].some((r) => r.textContent.includes('testing the report button'))), 'report shows up in the admin panel');
    const det = await admin.$('.report details');
    if (det) await det.evaluate((d) => { d.open = true; });
    await admin.setViewport({ width: 1366, height: 900 });
    await admin.screenshot({ path: ADMIN_SHOT, fullPage: true });
    console.log(`admin screenshot -> ${ADMIN_SHOT}`);
    await admin.click('[data-tab="log"]');
    ok(await admin.waitForFunction(() => document.body.textContent.includes('cam-off'), { timeout: 5000 }).then(() => true, () => false), 'action log lists the cam-off');
  }

  // Signed-in phones reach the APK, sign out, and audio settings from the profile chip.
  const barFit = (page) => page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    const music = document.querySelector('[data-action="music"]');
    const profile = document.querySelector('[data-action="profile"]');
    const mr = music?.getBoundingClientRect();
    const pr = profile?.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const iconShown = (el, box) => !!(el && box && box.width > 0 && box.right <= window.innerWidth + 1 && getComputedStyle(el).display !== 'none');
    return {
      h: r.height,
      overflow: Math.max(bar.scrollWidth - bar.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      music: iconShown(music, mr) && music.getAttribute('aria-label') === 'Music' && getComputedStyle(music.querySelector('.line-icon')).display !== 'none',
      profile: iconShown(profile, pr),
      barDownload: !!document.querySelector('a.top-download, a[data-action="get-app"]'),
    };
  });
  const profileActions = (page) => page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
    const visible = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
    };
    return {
      app: text('a[data-action="get-app-menu"]') === 'Get the app' && document.querySelector('a[data-action="get-app-menu"]')?.getAttribute('href') === '/download' && visible('a[data-action="get-app-menu"]'),
      out: text('[data-action="sign-out"]') === 'Sign out' && visible('[data-action="sign-out"]'),
      av: text('[data-action="profile-av"]') === 'Audio & video' && visible('[data-action="profile-av"]'),
    };
  });
  const backToApp = async (page) => {
    await page.goBack({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.topbar');
  };
  const enterLobby = async (page) => {
    if (await page.$('.room-card[data-room="lobby"]')) return;
    await page.click('[data-action="more"]');
    await page.click('[data-action="leave"]');
    await page.waitForSelector('.room-card[data-room="lobby"]');
  };
  const enterRoom = async (page) => {
    if (await page.$('.chat-form input')) return;
    await page.waitForSelector('.room-card[data-room="lobby"]');
    await page.click('.room-card[data-room="lobby"]');
    await page.waitForSelector('.chat-form input');
  };
  await bob.setViewport({ width: 1366, height: 768 });
  await enterRoom(bob);
  await bob.click('[data-action="more"]');
  await bob.waitForSelector('.more-menu');
  ok(!(await bob.$('.more-menu [data-action="profile-av"], .more-menu [data-action="av-settings"]'))
    && !(await bob.$eval('.more-menu', (el) => /Audio & video/i.test(el.textContent || ''))),
    'three-lines menu no longer has Audio & video');
  await bob.click('[data-action="more"]');
  await bob.click('[data-action="profile"]');
  await bob.waitForSelector('[data-action="profile-av"]');
  const deskProfile = await profileActions(bob);
  ok(deskProfile.app && deskProfile.out && deskProfile.av, `desktop profile menu has Get the app, Sign out, and Audio & video (${JSON.stringify(deskProfile)})`);
  await bob.click('[data-action="profile-av"]');
  await bob.waitForSelector('.av-modal');
  ok(await bob.$eval('.av-modal', (el) => el.getAttribute('aria-label')) === 'Audio & video settings', 'Audio & video opens the settings dialog');
  await bob.click('.av-modal [data-action="av-cancel"]');
  await bob.waitForFunction(() => !document.querySelector('.av-modal'));
  await bob.click('[data-action="music"]');
  await bob.waitForSelector('.radio-panel');
  const musicIcon = await bob.evaluate(() => {
    const btn = document.querySelector('[data-action="music"]');
    const icon = btn?.querySelector('.line-icon');
    const label = btn?.querySelector('.radio-label');
    const panel = document.querySelector('.radio-panel');
    const br = btn?.getBoundingClientRect();
    const lr = label?.getBoundingClientRect();
    return {
      name: btn?.getAttribute('aria-label'),
      icon: !!icon && getComputedStyle(icon).display !== 'none',
      labelHidden: !!lr && lr.width <= 1,
      wide: (br?.width ?? 0) <= 48,
      panel: panel?.getAttribute('aria-label') === 'Music',
    };
  });
  ok(musicIcon.name === 'Music' && musicIcon.icon && musicIcon.labelHidden && musicIcon.wide && musicIcon.panel, `Music is an icon that opens the radio dropdown (${JSON.stringify(musicIcon)})`);
  await bob.keyboard.press('Escape');
  await bob.setViewport({ width: 390, height: 844 });
  await enterRoom(bob);
  const room390 = await barFit(bob);
  ok(room390.h <= 56 && room390.overflow <= 0 && room390.music && room390.profile && !room390.barDownload, `room 390: profile and Music fit the bar (${JSON.stringify(room390)})`);
  await bob.setViewport({ width: 360, height: 844 });
  const room360 = await barFit(bob);
  ok(room360.h <= 56 && room360.overflow <= 0 && room360.music && room360.profile && !room360.barDownload, `room 360: bar does not overflow (${JSON.stringify(room360)})`);
  const profileOnScreen = (page) => page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items = [...document.querySelectorAll('.me-pop-panel .profile-actions button, .me-pop-panel .profile-actions a')];
    const boxes = items.map((el) => {
      const b = el.getBoundingClientRect();
      return {
        t: (el.textContent || '').trim(),
        left: Math.round(b.left),
        right: Math.round(b.right),
        inside: b.width > 20 && b.left >= -1 && b.right <= vw + 1 && b.top >= -1 && b.bottom <= vh + 1,
      };
    });
    return { vw, scroll: document.documentElement.scrollWidth, n: items.length, boxes, ok: items.length >= 3 && boxes.every((b) => b.inside) && document.documentElement.scrollWidth <= vw + 1 };
  });
  await bob.setViewport({ width: 390, height: 844 });
  await bob.click('[data-action="profile"]');
  await bob.waitForSelector('a[data-action="get-app-menu"]');
  const phoneProfile = await profileActions(bob);
  ok(phoneProfile.app && phoneProfile.out && phoneProfile.av, `phone profile menu has Get the app, Sign out, and Audio & video (${JSON.stringify(phoneProfile)})`);
  const roomMenu390 = await profileOnScreen(bob);
  ok(roomMenu390.ok, `room 390: profile menu stays on screen (${JSON.stringify(roomMenu390)})`);
  await bob.setViewport({ width: 360, height: 844 });
  const roomMenu360 = await profileOnScreen(bob);
  ok(roomMenu360.ok, `room 360: profile menu stays on screen (${JSON.stringify(roomMenu360)})`);
  await bob.setViewport({ width: 390, height: 844 });
  await bob.click('a[data-action="get-app-menu"]');
  await bob.waitForFunction(() => location.pathname === '/download');
  ok(true, 'room: profile menu opens /download');
  await backToApp(bob);
  await enterLobby(bob);
  await bob.setViewport({ width: 390, height: 844 });
  const lobby390 = await barFit(bob);
  ok(lobby390.h <= 56 && lobby390.overflow <= 0 && lobby390.music && lobby390.profile && !lobby390.barDownload, `lobby 390: profile and Music fit the bar (${JSON.stringify(lobby390)})`);
  await bob.setViewport({ width: 360, height: 844 });
  const lobby360 = await barFit(bob);
  ok(lobby360.h <= 56 && lobby360.overflow <= 0 && lobby360.music && lobby360.profile && !lobby360.barDownload, `lobby 360: bar does not overflow (${JSON.stringify(lobby360)})`);
  await bob.setViewport({ width: 390, height: 844 });
  await bob.click('[data-action="profile"]');
  await bob.waitForSelector('a[data-action="get-app-menu"]');
  const lobbyMenu390 = await profileOnScreen(bob);
  ok(lobbyMenu390.ok, `lobby 390: profile menu stays on screen (${JSON.stringify(lobbyMenu390)})`);
  await bob.screenshot({ path: path.join(path.dirname(SHOT), 'profile-lobby-390.png') });
  await bob.setViewport({ width: 360, height: 844 });
  const lobbyMenu360 = await profileOnScreen(bob);
  ok(lobbyMenu360.ok, `lobby 360: profile menu stays on screen (${JSON.stringify(lobbyMenu360)})`);
  await bob.screenshot({ path: path.join(path.dirname(SHOT), 'profile-lobby-360.png') });
  await bob.setViewport({ width: 390, height: 844 });
  await bob.click('a[data-action="get-app-menu"]');
  await bob.waitForFunction(() => location.pathname === '/download');
  ok(true, 'lobby: profile menu opens /download');
} catch (e) {
  failed++;
  console.log('FAIL  exception:', e.message);
} finally {
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
