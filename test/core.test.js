const test = require('node:test');
const assert = require('node:assert/strict');
const { getAppPrefix, extractCode, parseImportText, filterAccounts, lastMailInfo } = require('../public/assets/core.js');

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

test('classifies the last-mail time of an account', () => {
  assert.deepEqual(lastMailInfo({ last_mail_at: 1794650000, last_mail_sync: 1794660000 }), { state: 'has', ts: 1794650000000, sync: 1794660000000 });
  // 读信时记录到了时间，但还没做过完整同步
  assert.deepEqual(lastMailInfo({ last_mail_at: 1794650000, last_mail_sync: null }), { state: 'has', ts: 1794650000000, sync: 0 });
  assert.deepEqual(lastMailInfo({ last_mail_at: null, last_mail_sync: 1794660000 }), { state: 'empty', ts: 0, sync: 1794660000000 });
  assert.deepEqual(lastMailInfo({ last_mail_at: null, last_mail_sync: null }), { state: 'never', ts: 0, sync: 0 });
  assert.deepEqual(lastMailInfo({}), { state: 'never', ts: 0, sync: 0 });
});
