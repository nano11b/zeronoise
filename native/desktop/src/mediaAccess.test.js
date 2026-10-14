const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decidePermissionCheck, decidePermissionRequest, windowsMediaBlock } = require('./mediaAccess');

const SITE = 'https://chat.nano11bravo.com';
const slash = {
  securityOrigin: 'https://chat.nano11bravo.com/',
  requestingUrl: 'https://chat.nano11bravo.com/',
  mediaType: 'video',
};

test('a trailing slash on the site origin still allows camera and mic checks', () => {
  assert.equal(decidePermissionCheck('media', 'https://chat.nano11bravo.com/', slash, SITE), true);
  assert.equal(decidePermissionCheck('speaker-selection', 'https://chat.nano11bravo.com/', slash, SITE), true);
  assert.equal(decidePermissionCheck('display-capture', 'https://chat.nano11bravo.com/', slash, SITE), true);
});

test('another website cannot pass the media check', () => {
  const evil = { securityOrigin: 'https://evil.example/', requestingUrl: 'https://evil.example/watch' };
  assert.equal(decidePermissionCheck('media', 'https://evil.example/', evil, SITE), false);
});

test('a blank origin is the device enumerator and is allowed', () => {
  assert.equal(decidePermissionCheck('media', '', {}, SITE), true);
  assert.equal(decidePermissionCheck('media', '', { mediaType: 'audio' }, SITE), true);
});

test('a blank requesting origin does not override a foreign security origin', () => {
  assert.equal(decidePermissionCheck('media', '', { securityOrigin: 'https://evil.example' }, SITE), false);
});

test('non-media permissions stay as they were', () => {
  assert.equal(decidePermissionCheck('fullscreen', 'https://chat.nano11bravo.com/', slash, SITE), true);
  assert.equal(decidePermissionCheck('geolocation', 'https://chat.nano11bravo.com/', slash, SITE), false);
  assert.equal(decidePermissionCheck('background-sync', 'https://chat.nano11bravo.com/', slash, SITE), false);
});

test('permission requests use the same origin rule', () => {
  assert.equal(decidePermissionRequest('media', slash, SITE), true);
  assert.equal(decidePermissionRequest('media', { requestingUrl: 'https://evil.example/' }, SITE), false);
});

test('windows privacy copy only when desktop access is denied', () => {
  assert.equal(windowsMediaBlock('granted', 'granted'), null);
  assert.equal(windowsMediaBlock('unknown', 'unknown'), null);
  const both = windowsMediaBlock('denied', 'denied');
  assert.match(both.message, /camera and microphone/);
  assert.match(both.detail, /Let desktop apps access your camera/);
  assert.match(windowsMediaBlock('restricted', 'granted').message, /camera/);
  assert.doesNotMatch(windowsMediaBlock('granted', 'denied').message, /camera and/);
});
