const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, decideUpdate } = require('./updateCheck');

test('1.1.0 is older than 1.2.0', () => {
  assert.equal(compareVersions('1.1.0', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.1.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test('an installed app at or above minVersion can apply 1.2.0', () => {
  assert.equal(decideUpdate({ current: '1.1.0', latest: '1.2.0', minVersion: '1.1.0', canApply: true }), 'install');
  assert.equal(decideUpdate({ current: '1.2.0', latest: '1.2.0', minVersion: '1.1.0', canApply: true }), 'current');
  assert.equal(decideUpdate({ current: '1.2.0', latest: '1.3.0', minVersion: '1.2.0', canApply: true }), 'install');
});

test('a 1.2.0 install updates to 1.2.1 when it is still above minVersion', () => {
  assert.equal(decideUpdate({ current: '1.2.0', latest: '1.2.1', minVersion: '1.2.0', canApply: true }), 'install');
  assert.equal(decideUpdate({ current: '1.2.0', latest: '1.2.1', minVersion: '1.1.0', canApply: true }), 'install');
  assert.equal(decideUpdate({ current: '1.2.1', latest: '1.2.1', minVersion: '1.2.0', canApply: true }), 'current');
});

test('a portable zip and a build below minVersion need a manual install', () => {
  assert.equal(decideUpdate({ current: '1.1.0', latest: '1.2.0', minVersion: '1.2.0', canApply: false }), 'manual');
  assert.equal(decideUpdate({ current: '1.0.0', latest: '1.2.0', minVersion: '1.1.0', canApply: true }), 'manual');
});
