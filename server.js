// outlook-pool — 批量 Outlook 邮箱池（Graph API + refresh_token 管理）
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const PORT = 8443;
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

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 鉴权已由 nginx auth_request 统一处理，此处无需再校验 ----

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function refreshAccessToken(account) {
  const body = new URLSearchParams({
    client_id: account.client_id,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error_description || j.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  // refresh_token 轮换：存回新的
  if (j.refresh_token && j.refresh_token !== account.refresh_token) {
    db.prepare('UPDATE accounts SET refresh_token=? WHERE id=?').run(j.refresh_token, account.id);
  }
  return j.access_token;
}

async function graphGet(accessToken, url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Graph HTTP ${r.status}`);
  return j;
}

// ---- 批量导入：每行 邮箱----密码----client_id----refresh_token ----
app.post('/api/accounts/import', (req, res) => {
  const text = String(req.body.text || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ins = db.prepare(`INSERT INTO accounts (email,password,client_id,refresh_token)
    VALUES (?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password=excluded.password, client_id=excluded.client_id, refresh_token=excluded.refresh_token, status='unknown', last_error=NULL`);
  let ok = 0, bad = [];
  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = line.split('----').map(s => s.trim());
      if (parts.length < 4 || !parts[0].includes('@')) { bad.push(line.slice(0, 60)); continue; }
      ins.run(parts[0], parts[1] || '', parts[2], parts.slice(3).join('----'));
      ok++;
    }
  });
  tx();
  res.json({ ok, bad });
});

app.get('/api/accounts', (req, res) => {
  const rows = db.prepare('SELECT id,email,client_id,status,last_error,last_check,created_at FROM accounts ORDER BY id DESC').all();
  res.json({ accounts: rows, total: rows.length });
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
    await refreshAccessToken(acc);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
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
  for (const acc of rows) {
    try {
      await refreshAccessToken(acc);
      db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
      results.ok++;
    } catch (e) {
      const dead = /invalid_grant|expired|revoked/i.test(e.message);
      db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
        .run(dead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
      results[dead ? 'dead' : 'error']++;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  res.json(results);
});

// ---- 取邮件列表 ----
app.get('/api/accounts/:id/messages', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  const top = Math.min(parseInt(req.query.top) || 10, 50);
  const folder = req.query.folder || 'inbox';
  try {
    const token = await refreshAccessToken(acc);
    const j = await graphGet(token,
      `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime desc`);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    res.json({ messages: j.value || [] });
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
    const token = await refreshAccessToken(acc);
    const j = await graphGet(token,
      `${GRAPH}/me/messages/${encodeURIComponent(req.params.msgId)}?$select=subject,from,toRecipients,receivedDateTime,body`);
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
  const token = await refreshAccessToken(acc);
  const j = await graphGet(token,
    `${GRAPH}/me/mailFolders/inbox/messages?$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc`);
  let msgs = j.value || [];
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
  try {
    const msgs = await getRecentMessages(acc, top, null);
    db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
    res.json({
      email: acc.email,
      messages: msgs.map(m => ({
        id: m.id, subject: m.subject,
        from: m.from?.emailAddress?.address,
        received: m.receivedDateTime,
        preview: m.bodyPreview,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message, email });
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
  const rows = db.prepare("SELECT email FROM accounts WHERE status IN ('ok','unknown') ORDER BY RANDOM() LIMIT 1").all();
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
  for (const acc of rows) {
    try {
      await refreshAccessToken(acc);
      db.prepare("UPDATE accounts SET status='ok', last_error=NULL, last_check=strftime('%s','now') WHERE id=?").run(acc.id);
      ok++;
    } catch (e) {
      const isDead = /invalid_grant|expired|revoked/i.test(e.message);
      db.prepare('UPDATE accounts SET status=?, last_error=?, last_check=strftime(\'%s\',\'now\') WHERE id=?')
        .run(isDead ? 'dead' : 'error', e.message.slice(0, 300), acc.id);
      isDead ? dead++ : err++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[auto-check] ok=${ok} error=${err} dead=${dead}`);
}
setInterval(() => autoCheckAll().catch(e => console.error('[auto-check]', e.message)), 24 * 60 * 60 * 1000); // 每天一次
setTimeout(() => autoCheckAll().catch(() => {}), 60000); // 启动 60 秒后先跑一轮

app.listen(PORT, '127.0.0.1', () => console.log(`outlook-pool on 127.0.0.1:${PORT}`));
