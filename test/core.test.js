const test = require('node:test');
const assert = require('node:assert/strict');
const { getAppPrefix, extractCode, parseImportText, filterAccounts } = require('../public/assets/core.js');

test('detects the production /pool mount prefix', () => {
  assert.equal(getAppPrefix('/pool'), '/pool');
  assert.equal(getAppPrefix('/pool/'), '/pool');
  assert.equal(getAppPrefix('/pool/inbox'), '/pool');
  assert.equal(getAppPrefix('/'), '');
  assert.equal(getAppPrefix('/other'), '');
});

test('extracts prioritized numeric and alphanumeric verification codes', () => {
  assert.equal(extractCode('Your verification code is 482913. Ref 123456'), '482913');
  assert.equal(extractCode('Here is the Steam Guard code you need to login: JX8K2'), 'JX8K2');
  assert.equal(extractCode('验证码：034561，请勿泄露'), '034561');
  assert.equal(extractCode('034561'), '034561');
  assert.equal(extractCode('No verification token here'), null);
});

test('summarizes import input without exposing tokens', () => {
  const result = parseImportText([
    'a@outlook.com----pass----client----token',
    'not-an-account',
    '',
    'b@outlook.com--------client----token----with----dashes',
  ].join('\n'));
  assert.deepEqual(result, { total: 3, good: 2, bad: 1 });
});

test('filters accounts by normalized status and case-insensitive email search', () => {
  const accounts = [
    { email: 'Alice@outlook.com', status: 'ok' },
    { email: 'bob@hotmail.com', status: 'dead' },
    { email: 'carol@outlook.com', status: null },
  ];
  assert.deepEqual(filterAccounts(accounts, 'ok', '').map(a => a.email), ['Alice@outlook.com']);
  assert.deepEqual(filterAccounts(accounts, 'unknown', '').map(a => a.email), ['carol@outlook.com']);
  assert.deepEqual(filterAccounts(accounts, 'all', 'OUTLOOK').map(a => a.email), ['Alice@outlook.com', 'carol@outlook.com']);
  assert.deepEqual(filterAccounts(accounts, 'dead', 'alice'), []);
});
