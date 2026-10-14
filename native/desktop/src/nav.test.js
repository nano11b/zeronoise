const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const nav = require('./nav');
const desktopConfig = require('../config.json');
const sharedConfig = require('../../config.json');

test('desktop config matches the shared native config', () => {
  assert.deepEqual(desktopConfig, sharedConfig);
});

const SITE = 'https://chat.nano11bravo.com';

test('same-site pages stay in the window', () => {
  assert.equal(nav.classifyNavigation('https://chat.nano11bravo.com/room/lobby', SITE).action, 'inapp');
  assert.equal(nav.classifyNavigation('https://chat.nano11bravo.com/api/me', SITE).action, 'inapp');
});

test('oauth starts are handed to the system browser', () => {
  assert.equal(nav.classifyNavigation('https://chat.nano11bravo.com/api/auth/google', SITE).action, 'oauth');
  assert.equal(nav.classifyNavigation('https://chat.nano11bravo.com/api/auth/discord?foo=1', SITE).action, 'oauth');
});

test('other websites, mail, and phone links leave the app', () => {
  assert.equal(nav.classifyNavigation('https://example.com/watch', SITE).action, 'external');
  assert.equal(nav.classifyNavigation('mailto:hi@example.com', SITE).action, 'external');
  assert.equal(nav.classifyNavigation('http://evil.example/phish', SITE).action, 'external');
});

test('the auth scheme is recognized and other schemes are ignored', () => {
  assert.equal(nav.classifyNavigation('camchat://auth?token=abc', SITE).action, 'auth');
  assert.equal(nav.classifyNavigation('javascript:alert(1)', SITE).action, 'ignore');
  assert.equal(nav.classifyNavigation('not a url', SITE).action, 'ignore');
});

test('oauth url carries the challenge and not the verifier', () => {
  const { verifier, challenge } = nav.newVerifier();
  const out = new URL(nav.withNativeChallenge('https://chat.nano11bravo.com/api/auth/google', challenge));
  assert.equal(out.searchParams.get('client'), 'native');
  assert.equal(out.searchParams.get('nonce'), challenge);
  assert.equal(out.searchParams.get('nonce'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(out.searchParams.has('verifier'), false);
});

test('callback parsing and the in-app handoff url', () => {
  const { verifier, challenge } = nav.newVerifier();
  const parsed = nav.parseAuthCallback(`camchat://auth?token=abc123&nonce=${challenge}`);
  assert.equal(parsed.challenge, challenge);
  assert.equal(parsed.token, 'abc123');
  assert.equal(nav.parseAuthCallback('camchat://other?token=abc'), null);
  const page = new URL(nav.handoffPage(SITE, 'abc123', verifier));
  assert.equal(page.origin + page.pathname, 'https://chat.nano11bravo.com/api/auth/native');
  assert.equal(page.searchParams.get('token'), 'abc123');
  assert.equal(page.searchParams.get('verifier'), verifier);
  const err = new URL(nav.authErrorPage(SITE, 'Sign-in expired, please try again.'));
  assert.equal(err.searchParams.get('authError'), 'Sign-in expired, please try again.');
});
