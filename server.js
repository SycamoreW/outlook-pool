// outlook-pool — 批量 Outlook 邮箱池（Graph API + refresh_token 管理）
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const PORT = 8443;
const POOL_KEY = process.env.POOL_KEY || '';
// 鉴权由 nginx auth_request（Wutong 通用登录）统一处理，本服务只监听 127.0.0.1
const db = new Database(path.join(__dirname, 'data', 'pool.db'));
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT,
  client_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  status TEXT DEFAULT 'unknown',
  last_error TEXT,
  last_check INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`);
// 迁移：last_mail_at = 最新一封邮件的时间（秒），last_mail_sync = 上次同步这个时间的时刻（秒）
{
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  if (!cols.has('last_mail_at')) db.exec('ALTER TABLE accounts ADD COLUMN last_mail_at INTEGER');
  if (!cols.has('last_mail_sync')) db.exec('ALTER TABLE accounts ADD COLUMN last_mail_sync INTEGER');
  if (!cols.has('tag')) db.exec("ALTER TABLE accounts ADD COLUMN tag TEXT DEFAULT ''");
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Authenticate only the automation-facing quick API. Management endpoints
// continue to rely on the existing nginx login and are not publicly routed.
app.use('/api/quick', (req, res, next) => {
  const supplied = String(req.get('x-api-key') || '').trim();
  const expected = Buffer.from(POOL_KEY);
  const received = Buffer.from(supplied);
  if (!POOL_KEY || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---- 鉴权已由 nginx auth_request 统一处理，此处无需再校验 ----

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const OUTLOOK_REST = 'https://outlook.office.com/api/v2.0';

async function requestTokenWithScope(account, scope) {
  const params = {
    client_id: account.client_id,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  };
  if (scope) params.scope = scope;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error_description || j.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  if (j.refresh_token && j.refresh_token !== account.refresh_token) {
    db.prepare('UPDATE accounts SET refresh_token=? WHERE id=?').run(j.refresh_token, account.id);
    account.refresh_token = j.refresh_token;
  }
  const granted = String(j.scope || '');
  const protocol = granted.includes('graph.microsoft.com') ? 'graph' : 'rest';
  return { accessToken: j.access_token, protocol, scope: granted };
}

async function refreshAccessToken(account) {
  const attempts = [
    'https://graph.microsoft.com/Mail.Read offline_access',
    null, // 不传 scope，沿用原授权（兼容 Thunderbird 等仅授权 outlook.office.com 的 token）
    'https://outlook.office.com/Mail.ReadWrite offline_access',
  ];
  let lastErr;
  for (const scope of attempts) {
    try {
      return await requestTokenWithScope(account, scope);
    } catch (e) {
      lastErr = e;
      // 只有 scope 不匹配/未授权时才降级尝试下一种协议；账号密码失效/被封等直接抛出
      if (!/AADSTS70000|invalid_scope|unauthorized_client|scope/i.test(e.message)) {
        throw e;
      }
    }
  }
  throw lastErr;
}

async function apiGet(accessToken, url, timeoutMs = 30000) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `API HTTP ${r.status}`);
  return j;
}

function normalizeRestAddr(obj) {
  const ea = obj?.EmailAddress || obj?.emailAddress;
  if (!ea) return null;
  return { emailAddress: { name: ea.Name || ea.name || '', address: ea.Address || ea.address || '' } };
}

function normalizeRestMessage(m) {
  if (!m) return m;
  return {
    id: m.Id || m.id,
    internetMessageId: m.InternetMessageId || m.internetMessageId || null,
    subject: m.Subject ?? m.subject ?? '',
    from: normalizeRestAddr(m.From || m.from),
    sender: normalizeRestAddr(m.Sender || m.sender),
    toRecipients: (m.ToRecipients || m.toRecipients || []).map(normalizeRestAddr).filter(Boolean),
    ccRecipients: (m.CcRecipients || m.ccRecipients || []).map(normalizeRestAddr).filter(Boolean),
    replyTo: (m.ReplyTo || m.replyTo || []).map(normalizeRestAddr).filter(Boolean),
    receivedDateTime: m.ReceivedDateTime || m.receivedDateTime || null,
    sentDateTime: m.SentDateTime || m.sentDateTime || null,
    isRead: m.IsRead ?? m.isRead ?? false,
    hasAttachments: m.HasAttachments ?? m.hasAttachments ?? false,
    bodyPreview: m.BodyPreview ?? m.bodyPreview ?? '',
    webLink: m.WebLink || m.webLink || null,
    body: m.Body ? { contentType: m.Body.ContentType || m.Body.contentType, content: m.Body.Content || m.Body.content } : m.body,
  };
}

async function fetchFolderMessages(tok, folder, top, { includeBody = false, timeoutMs = 30000 } = {}) {
  if (tok.protocol === 'graph') {
    const sel = includeBody
      ? 'id,subject,from,receivedDateTime,bodyPreview,body'
      : 'id,subject,from,receivedDateTime,isRead,bodyPreview';
    const j = await apiGet(tok.accessToken,
      `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=${sel}&$orderby=receivedDateTime desc`, timeoutMs);
    return j.value || [];
  } else {
    const sel = includeBody
      ? 'Id,Subject,From,ReceivedDateTime,BodyPreview,Body'
      : 'Id,Subject,From,ReceivedDateTime,IsRead,BodyPreview';
    const j = await apiGet(tok.accessToken,
      `${OUTLOOK_REST}/me/mailfolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=${sel}&$orderby=ReceivedDateTime desc`, timeoutMs);
    return (j.value || []).map(normalizeRestMessage);
  }
}

async function fetchSingleMessage(tok, msgId, full = false) {
  if (tok.protocol === 'graph') {
    const fields = full
      ? 'id,internetMessageId,subject,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview,body,webLink'
      : 'subject,from,toRecipients,receivedDateTime,body';
    return await apiGet(tok.accessToken, `${GRAPH}/me/messages/${encodeURIComponent(msgId)}?$select=${fields}`);
  } else {
    const fields = full
      ? 'Id,InternetMessageId,Subject,From,Sender,ToRecipients,CcRecipients,ReplyTo,ReceivedDateTime,SentDateTime,IsRead,HasAttachments,BodyPreview,Body,WebLink'
      : 'Subject,From,ToRecipients,ReceivedDateTime,Body';
    const m = await apiGet(tok.accessToken, `${OUTLOOK_REST}/me/messages/${encodeURIComponent(msgId)}?$select=${fields}`);
    return normalizeRestMessage(m);
  }
}

// ---- 最新邮件时间：收件箱 + 垃圾箱里最新一封的 receivedDateTime ----
const LAST_MAIL_FOLDERS = ['inbox', 'junkemail'];
const toEpochSec = iso => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

async function fetchLastMailAt(tok) {
  const times = await Promise.all(LAST_MAIL_FOLDERS.map(async folder => {
    const url = tok.protocol === 'graph'
      ? `${GRAPH}/me/mailFolders/${folder}/messages?$top=1&$select=receivedDateTime&$orderby=receivedDateTime desc`
      : `${OUTLOOK_REST}/me/mailfolders/${folder}/messages?$top=1&$select=ReceivedDateTime&$orderby=ReceivedDateTime desc`;
    const j = await apiGet(tok.accessToken, url, 8000);
    const item = j.value?.[0];
    return toEpochSec(item?.receivedDateTime || item?.ReceivedDateTime);
  }));
  const found = times.filter(t => t !== null);
  return found.length ? Math.max(...found) : null;
}

// 检查账号时顺带同步。拉取失败不影响账号状态，只是这次不更新。
async function syncLastMail(acc, accessToken) {
  try {
    const ts = await fetchLastMailAt(accessToken);
    db.prepare("UPDATE accounts SET last_mail_at=?, last_mail_sync=strftime('%s','now') WHERE id=?").run(ts, acc.id);
    return true;
  } catch (e) {
    return false;
  }
}

// 批量检查用：连续 3 次拉取失败（多半是 Graph 故障）后本轮不再尝试，避免拖慢整轮检查。
function createMailSyncer(maxFails = 3) {
  let fails = 0;
  return async (acc, accessToken) => {
    if (fails >= maxFails) return;
    fails = (await syncLastMail(acc, accessToken)) ? 0 : fails + 1;
  };
}

// 读信时顺带记录（messages 按时间倒序）。只会把时间往新的方向推。
function noteMailSeen(accId, messages) {
  const ts = toEpochSec(messages?.[0]?.receivedDateTime);
  if (ts !== null) db.prepare('UPDATE accounts SET last_mail_at=MAX(COALESCE(last_mail_at,0),?) WHERE id=?').run(ts, accId);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractLinks(...parts) {
  const source = decodeHtmlEntities(parts.filter(Boolean).join('\n'));
  const matches = source.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map(url => url.replace(/[),.;!?\]}]+$/g, '')))];
}

function extractMagicLinks(links) {
  const strong = /(?:magic|verify|verification|confirm|activate|activation|authenticate|authorization|sign-?in|login|callback|continue|ticket|token)/i;
  return links.filter(url => strong.test(url));
}

function serializeMessage(message, { includeBody = true } = {}) {
  const bodyType = message.body?.contentType || null;
  const bodyContent = message.body?.content || '';
  const text = bodyType && bodyType.toLowerCase() === 'html' ? htmlToText(bodyContent) : String(bodyContent || '');
  const links = extractLinks(bodyContent, message.bodyPreview);
  const result = {
    id: message.id,
    internet_message_id: message.internetMessageId || null,
    subject: message.subject || '',
    from: message.from?.emailAddress || null,
    sender: message.sender?.emailAddress || null,
    to: (message.toRecipients || []).map(r => r.emailAddress).filter(Boolean),
    cc: (message.ccRecipients || []).map(r => r.emailAddress).filter(Boolean),
    reply_to: (message.replyTo || []).map(r => r.emailAddress).filter(Boolean),
    received: message.receivedDateTime || null,
    sent: message.sentDateTime || null,
    is_read: Boolean(message.isRead),
    has_attachments: Boolean(message.hasAttachments),
    preview: message.bodyPreview || '',
    web_link: message.webLink || null,
    links,
    magic_links: extractMagicLinks(links),
  };
  if (includeBody) {
    result.body = { content_type: bodyType, content: bodyContent };
    result.text = text;
  }
  return result;
}

// ---- 批量导入：每行 邮箱----密码----client_id----refresh_token ----
app.post('/api/accounts/import', (req, res) => {
  const text = String(req.body.text || '');
  const tag = String(req.body.tag || '').trim();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ins = db.prepare(`INSERT INTO accounts (email,password,client_id,refresh_token,tag)
    VALUES (?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password=excluded.password, client_id=excluded.client_id, refresh_token=excluded.refresh_token, status='unknown', last_error=NULL, tag=CASE WHEN excluded.tag!='' THEN excluded.tag ELSE accounts.tag END`);
  let ok = 0, bad = [];
  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = line.split('----').map(s => s.trim());
      if (parts.length < 4 || !parts[0].includes('@')) { bad.push(line.slice(0, 60)); continue; }
      ins.run(parts[0], parts[1] || '', parts[2], parts.slice(3).join('----'), tag);
      ok++;
    }
  });
  tx();
  res.json({ ok, bad });
});

app.get('/api/accounts', (req, res) => {
  const rows = db.prepare("SELECT id,email,client_id,status,last_error,last_check,created_at,last_mail_at,last_mail_sync,COALESCE(tag,'') AS tag FROM accounts ORDER BY id DESC").all();
  res.json({ accounts: rows, total: rows.length });
});

app.patch('/api/accounts/:id/tag', (req, res) => {
  const tag = String(req.body?.tag || '').trim();
  const info = db.prepare('UPDATE accounts SET tag=? WHERE id=?').run(tag, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, tag });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/accounts/clear-dead', (req, res) => {
  const n = db.prepare("DELETE FROM accounts WHERE status='dead'").run().changes;
  res.json({ ok: true, removed: n });
});

// ---- 检查/刷新单个账号 token ----
app.post('/api/accounts/:id/refresh', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  try {
    const token = await refreshAccessToken(acc);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    await syncLastMail(acc, token);
    res.json({ ok: true });
  } catch (e) {
    const dead = /invalid_grant|expired|revoked/i.test(e.message);
    db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
      .run(dead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
    res.json({ ok: false, error: e.message, dead });
  }
});

// ---- 批量检查全部账号（串行，防风控）----
app.post('/api/accounts/check-all', async (req, res) => {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY id').all();
  const results = { ok: 0, error: 0, dead: 0 };
  const syncMail = createMailSyncer();
  const pending = [];
  for (const acc of rows) {
    let token = null;
    try {
      token = await refreshAccessToken(acc);
      db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
      results.ok++;
    } catch (e) {
      const dead = /invalid_grant|expired|revoked/i.test(e.message);
      db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
        .run(dead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
      results[dead ? 'dead' : 'error']++;
    }
    // 最新邮件时间放后台查，节流间隔不变，不拉长整轮检查
    if (token) pending.push(syncMail(acc, token));
    await new Promise(r => setTimeout(r, 400));
  }
  await Promise.all(pending);
  res.json(results);
});

// ---- 取邮件列表 ----
app.get('/api/accounts/:id/messages', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  const top = Math.min(parseInt(req.query.top) || 10, 50);
  const folder = req.query.folder || 'inbox';
  try {
    const tok = await refreshAccessToken(acc);
    const msgs = await fetchFolderMessages(tok, folder, top, { includeBody: false });
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    noteMailSeen(acc.id, msgs);
    res.json({ messages: msgs });
  } catch (e) {
    const dead = /invalid_grant|expired|revoked/i.test(e.message);
    db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
      .run(dead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
    res.status(502).json({ error: e.message, dead });
  }
});

// ---- 取单封正文 ----
app.get('/api/accounts/:id/messages/:msgId', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  try {
    const tok = await refreshAccessToken(acc);
    const j = await fetchSingleMessage(tok, req.params.msgId, false);
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- 验证码提取工具 ----
const CODE_KEYWORDS = /(?:verification|security|confirm|code|otp|passcode|pin|验证码|校验码|动态码|授权码|代码)/i;
function extractCodes(text) {
  const t = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const found = [];
  // 关键词附近的数字码（优先级最高）
  const kwRe = /(?:code|otp|passcode|pin|验证码|校验码|动态码|授权码|代码|is|：|:)[^0-9A-Za-z]{0,15}([0-9]{4,8})\b/gi;
  let m;
  while ((m = kwRe.exec(t))) found.push({ code: m[1], score: 10 });
  // 独立 6 位数字
  const d6 = /\b([0-9]{6})\b/g;
  while ((m = d6.exec(t))) found.push({ code: m[1], score: 5 });
  // 独立 4-8 位数字
  const d48 = /\b([0-9]{4,8})\b/g;
  while ((m = d48.exec(t))) found.push({ code: m[1], score: 3 });
  // 字母数字混合码（如 AB12CD）
  const alnum = /(?:code|验证码|代码)[^A-Za-z0-9]{0,15}\b([A-Z0-9]{5,8})\b/g;
  while ((m = alnum.exec(t))) found.push({ code: m[1], score: 6 });
  if (!found.length) return null;
  found.sort((a, b) => b.score - a.score);
  return found[0].code;
}

async function getRecentMessages(acc, top, minutes) {
  const tok = await refreshAccessToken(acc);
  let msgs = await fetchFolderMessages(tok, 'inbox', top, { includeBody: true });
  noteMailSeen(acc.id, msgs);
  if (minutes) {
    const cutoff = Date.now() - minutes * 60000;
    msgs = msgs.filter(m => new Date(m.receivedDateTime).getTime() >= cutoff);
  }
  return msgs;
}

// ---- 快速 API：按邮箱地址取最新邮件 ----
app.get('/api/quick/latest', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'missing ?email=' });
  const acc = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
  if (!acc) return res.status(404).json({ error: 'account not in pool', email });
  const top = Math.min(parseInt(req.query.top) || 5, 20);
  const includeBody = /^(?:1|true|yes)$/i.test(String(req.query.include_body || ''));
  try {
    const msgs = await getRecentMessages(acc, top, null);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    res.json({
      email: acc.email,
      messages: msgs.map(m => includeBody
        ? serializeMessage(m, { includeBody: true })
        : {
            id: m.id, subject: m.subject,
            from: m.from?.emailAddress?.address,
            received: m.receivedDateTime,
            preview: m.bodyPreview,
          }),
    });
  } catch (e) {
    res.status(502).json({ error: e.message, email });
  }
});

// ---- 快速 API：按邮箱地址和 message_id 取单封完整正文 ----
app.get('/api/quick/message', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const messageId = String(req.query.message_id || req.query.id || '').trim();
  if (!email) return res.status(400).json({ error: 'missing ?email=' });
  if (!messageId) return res.status(400).json({ error: 'missing ?message_id=' });
  const acc = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
  if (!acc) return res.status(404).json({ error: 'account not in pool', email });
  try {
    const tok = await refreshAccessToken(acc);
    const message = await fetchSingleMessage(tok, messageId, true);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    res.json({ email: acc.email, message: serializeMessage(message, { includeBody: true }) });
  } catch (e) {
    const status = /not found|ErrorItemNotFound/i.test(e.message) ? 404 : 502;
    res.status(status).json({ error: e.message, email: acc.email, message_id: messageId });
  }
});

// ---- 快速 API：提取验证码 ----
app.get('/api/quick/code', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'missing ?email=' });
  const acc = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
  if (!acc) return res.status(404).json({ error: 'account not in pool', email });
  const minutes = Math.min(parseInt(req.query.minutes) || 10, 1440);
  const senderFilter = String(req.query.sender || '').toLowerCase();
  const top = Math.min(parseInt(req.query.top) || 10, 25);
  try {
    let msgs = await getRecentMessages(acc, top, minutes);
    if (senderFilter) msgs = msgs.filter(m => (m.from?.emailAddress?.address || '').toLowerCase().includes(senderFilter));
    for (const m of msgs) {
      const hay = `${m.subject || ''}\n${m.bodyPreview || ''}\n${m.body?.content || ''}`;
      const code = extractCodes(hay);
      if (code) {
        return res.json({
          email: acc.email, code,
          subject: m.subject,
          from: m.from?.emailAddress?.address,
          received: m.receivedDateTime,
          message_id: m.id,
        });
      }
    }
    res.status(404).json({ error: 'no code found', email: acc.email, checked: msgs.length, minutes });
  } catch (e) {
    res.status(502).json({ error: e.message, email });
  }
});

// ---- 快速 API：轮询等验证码（最长 120 秒）----
app.get('/api/quick/wait-code', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'missing ?email=' });
  const acc = db.prepare('SELECT * FROM accounts WHERE lower(email)=?').get(email);
  if (!acc) return res.status(404).json({ error: 'account not in pool', email });
  const timeoutSec = Math.min(parseInt(req.query.timeout) || 60, 120);
  const senderFilter = String(req.query.sender || '').toLowerCase();
  const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - 5 * 60000;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      let msgs = await getRecentMessages(acc, 10, null);
      msgs = msgs.filter(m => new Date(m.receivedDateTime).getTime() >= after);
      if (senderFilter) msgs = msgs.filter(m => (m.from?.emailAddress?.address || '').toLowerCase().includes(senderFilter));
      for (const m of msgs) {
        const hay = `${m.subject || ''}\n${m.bodyPreview || ''}\n${m.body?.content || ''}`;
        const code = extractCodes(hay);
        if (code) {
          return res.json({
            email: acc.email, code,
            subject: m.subject,
            from: m.from?.emailAddress?.address,
            received: m.receivedDateTime,
            message_id: m.id,
          });
        }
      }
    } catch (e) { /* 继续轮询 */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  res.status(408).json({ error: 'timeout waiting for code', email: acc.email, timeout: timeoutSec });
});

// ---- 快速 API：随机取一个健康账号（注册接码用）----
app.get('/api/quick/random', (req, res) => {
  const tag = String(req.query.tag || '').trim();
  const rows = tag
    ? db.prepare("SELECT email FROM accounts WHERE status IN ('ok','unknown') AND tag=? ORDER BY RANDOM() LIMIT 1").all(tag)
    : db.prepare("SELECT email FROM accounts WHERE status IN ('ok','unknown') ORDER BY RANDOM() LIMIT 1").all();
  if (!rows.length) return res.status(404).json({ error: 'no healthy account available' });
  res.json({ email: rows[0].email });
});

// ---- 导出（带 refresh_token 全量，方便备份）----
app.get('/api/accounts/export', (req, res) => {
  const rows = db.prepare('SELECT email,password,client_id,refresh_token,status FROM accounts ORDER BY id').all();
  const txt = rows.map(r => `${r.email}----${r.password || ''}----${r.client_id}----${r.refresh_token}`).join('\n');
  res.type('text/plain').send(txt);
});

// ---- 自动巡检：每 30 分钟自动检查全部账号 token ----
async function autoCheckAll() {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY id').all();
  if (!rows.length) return;
  let ok = 0, dead = 0, err = 0;
  const syncMail = createMailSyncer();
  const pending = [];
  for (const acc of rows) {
    let token = null;
    try {
      token = await refreshAccessToken(acc);
      db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
      ok++;
    } catch (e) {
      const isDead = /invalid_grant|expired|revoked/i.test(e.message);
      db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
        .run(isDead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
      isDead ? dead++ : err++;
    }
    if (token) pending.push(syncMail(acc, token));
    await new Promise(r => setTimeout(r, 500));
  }
  await Promise.all(pending);
  console.log(`[auto-check] ok=${ok} error=${err} dead=${dead}`);
}
setInterval(() => autoCheckAll().catch(e => console.error('[auto-check]', e.message)), 24 * 60 * 60 * 1000); // 每天一次
setTimeout(() => autoCheckAll().catch(() => {}), 60000); // 启动 60 秒后先跑一轮

app.listen(PORT, '127.0.0.1', () => console.log(`outlook-pool on 127.0.0.1:${PORT}`));
