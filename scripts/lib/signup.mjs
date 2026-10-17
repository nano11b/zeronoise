// batch H9: shared browser sign-up. Waits for the async CAPTCHA question before answering (typing early sent no
// challenge id -> "CAPTCHA expired"), and answers the fresh question once if the server still rejects it.
const answerOf = async (page) => {
  const m = /What is (\d+) \+ (\d+)/.exec(await page.evaluate(() => [...document.querySelectorAll('label')].map((l) => l.textContent || '').find((t) => /What is/.test(t)) || ''));
  return m ? String(+m[1] + +m[2]) : '';
};
async function fillCaptcha(page) {
  const cap = await page.$('input[name="captcha"]');
  if (!cap) return;
  await page.waitForFunction(() => [...document.querySelectorAll('label')].some((l) => /What is \d+ \+ \d+/.test(l.textContent || '')), { timeout: 10000 });
  const a = await answerOf(page);
  await cap.click({ clickCount: 3 }); await cap.type(a);
  await page.waitForFunction((v) => document.querySelector('input[name="captcha"]')?.value === v, { timeout: 3000 }, a);
}
export async function signUp(page, url, nick, { lobbyTimeout = 20000 } = {}) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.click('[data-tab="register"]');
  await page.type('input[name="username"]', nick);
  await page.type('input[name="email"]', `${nick.toLowerCase()}@example.com`);
  await page.type('input[name="password"]', `pw-${nick}-secret-1`);
  await page.type('input[name="password2"]', `pw-${nick}-secret-1`);
  await fillCaptcha(page);
  await page.waitForSelector('[data-action="account-submit"]:not([disabled])');
  await page.$eval('[data-action="account-submit"]', (b) => b.click());
  const lobby = () => page.waitForSelector('.room-card[data-room="lobby"]', { timeout: lobbyTimeout });
  await lobby().catch(async (e) => {
    const said = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
    console.log(`  (sign-up retry for ${nick}: ${String(e.message).slice(0, 80)}; page: ${said.slice(said.indexOf('CAPTCHA'), said.indexOf('CAPTCHA') + 80)})`);
    if (/CAPTCHA (expired|failed)|Wrong CAPTCHA/.test(said)) { await fillCaptcha(page); await page.$eval('[data-action="account-submit"]', (b) => b.click()); }
    else await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await lobby();
  });
}
