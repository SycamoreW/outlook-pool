(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.OutlookPoolCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function getAppPrefix(pathname) {
    return pathname === '/pool' || pathname.startsWith('/pool/') ? '/pool' : '';
  }

  function extractCode(text) {
    const value = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const found = [];
    let match;

    const keywordDigits = /(?:code|otp|passcode|pin|验证码|校验码|动态码|授权码|代码|is|：|:)[^0-9A-Za-z]{0,15}([0-9]{4,8})\b/gi;
    while ((match = keywordDigits.exec(value))) found.push({ code: match[1], score: 10 });

    // Some providers put explanatory text between “code” and an alphanumeric token.
    const alphaNumeric = /(?:[Cc]ode|验证码|代码)[^\n]{0,80}?\b([A-Z0-9]{5,8})\b/g;
    while ((match = alphaNumeric.exec(value))) found.push({ code: match[1], score: 6 });

    const sixDigits = /\b([0-9]{6})\b/g;
    while ((match = sixDigits.exec(value))) found.push({ code: match[1], score: 5 });

    const fallbackDigits = /\b([0-9]{4,8})\b/g;
    while ((match = fallbackDigits.exec(value))) found.push({ code: match[1], score: 3 });

    if (!found.length) return null;
    found.sort((a, b) => b.score - a.score);
    return found[0].code;
  }

  function parseImportText(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let good = 0;
    let bad = 0;
    for (const line of lines) {
      const parts = line.split('----');
      if (parts.length >= 4 && parts[0].includes('@')) good++;
      else bad++;
    }
    return { total: lines.length, good, bad };
  }

  function filterAccounts(accounts, filter, search, tagFilter = 'all') {
    const query = String(search || '').trim().toLowerCase();
    return accounts.filter(account => {
      const status = ['ok', 'error', 'dead'].includes(account.status) ? account.status : 'unknown';
      if (filter !== 'all' && status !== filter) return false;
      if (tagFilter !== 'all') {
        const tag = String(account.tag || '');
        if (tagFilter === '__untagged__') {
          if (tag !== '') return false;
        } else if (tag !== tagFilter) {
          return false;
        }
      }
      return !query || account.email.toLowerCase().includes(query);
    });
  }

  // 最新邮件时间的三种状态：has = 有邮件，empty = 同步过但邮箱是空的，never = 还没同步过
  function lastMailInfo(account) {
    const at = Number(account && account.last_mail_at) || 0;
    const sync = Number(account && account.last_mail_sync) || 0;
    if (at > 0) return { state: 'has', ts: at * 1000, sync: sync * 1000 };
    if (sync > 0) return { state: 'empty', ts: 0, sync: sync * 1000 };
    return { state: 'never', ts: 0, sync: 0 };
  }

  return { getAppPrefix, extractCode, parseImportText, filterAccounts, lastMailInfo };
});
