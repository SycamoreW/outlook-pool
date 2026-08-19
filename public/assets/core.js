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

  function filterAccounts(accounts, filter, search) {
    const query = String(search || '').trim().toLowerCase();
    return accounts.filter(account => {
      const status = ['ok', 'error', 'dead'].includes(account.status) ? account.status : 'unknown';
      if (filter !== 'all' && status !== filter) return false;
      return !query || account.email.toLowerCase().includes(query);
    });
  }

  return { getAppPrefix, extractCode, parseImportText, filterAccounts };
});
