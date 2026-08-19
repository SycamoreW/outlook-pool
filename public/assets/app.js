/* =========================================================
   Outlook Pool — WebUI 逻辑（原生 JS，零依赖）
   ========================================================= */
(() => {
  'use strict';

  // ---------------- 工具 ----------------
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // 仅用于受信任的静态图标/模板
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      node.append(c);
    }
    return node;
  }

  const ICONS = {
    check: '<svg class="ic" viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7 7a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l2.47 2.47 6.47-6.47a.75.75 0 0 1 1.06 0Z"/></svg>',
    cross: '<svg class="ic" viewBox="0 0 16 16"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>',
    copy: '<svg class="ic" viewBox="0 0 16 16"><path d="M5.75 1A1.75 1.75 0 0 0 4 2.75v.5h1.5v-.5a.25.25 0 0 1 .25-.25h7.5a.25.25 0 0 1 .25.25v7.5a.25.25 0 0 1-.25.25h-.5V12h.5A1.75 1.75 0 0 0 15 10.25v-7.5A1.75 1.75 0 0 0 13.25 1ZM2.75 4A1.75 1.75 0 0 0 1 5.75v7.5c0 .966.784 1.75 1.75 1.75h7.5A1.75 1.75 0 0 0 12 13.25v-7.5A1.75 1.75 0 0 0 10.25 4Zm-.25 1.75a.25.25 0 0 1 .25-.25h7.5a.25.25 0 0 1 .25.25v7.5a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25Z"/></svg>',
    refresh: '<svg class="ic" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89l.86-.86A.75.75 0 0 1 14 3.78V6.5a.75.75 0 0 1-.75.75h-2.72a.75.75 0 0 1-.53-1.28l.83-.83A4 4 0 1 0 12 8a.75.75 0 0 1 1.5 0Z"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 16 16"><path d="M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25ZM11 3V1.75A1.75 1.75 0 0 0 9.25 0h-2.5A1.75 1.75 0 0 0 5 1.75V3H1.75a.75.75 0 0 0 0 1.5h.443l.674 9.435A1.75 1.75 0 0 0 4.613 15.5h6.774a1.75 1.75 0 0 0 1.746-1.565L13.807 4.5h.443a.75.75 0 0 0 0-1.5Z"/></svg>',
    back: '<svg class="ic" viewBox="0 0 16 16"><path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"/></svg>',
    info: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9-3a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 7h1.5a.75.75 0 0 1 .75.75V11h.25a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1 0-1.5H7V8.5h-.25a.75.75 0 0 1 0-1.5Z"/></svg>',
  };

  const STATUS = {
    ok:      { label: '正常',   cls: 'ok' },
    error:   { label: '错误',   cls: 'error' },
    dead:    { label: '失效',   cls: 'dead' },
    unknown: { label: '未检查', cls: 'unknown' },
  };

  function relTime(tsMs) {
    if (!tsMs) return '';
    const diff = Date.now() - tsMs;
    if (diff < 0) return new Date(tsMs).toLocaleString();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return new Date(tsMs).toLocaleDateString();
  }
  const fullTime = tsMs => tsMs ? new Date(tsMs).toLocaleString() : '';

  function toast(msg, type = 'info', ms = 2600) {
    const icon = type === 'ok' ? ICONS.check : type === 'err' ? ICONS.cross : ICONS.info;
    const t = el('div', { class: `toast ${type}`, html: icon });
    t.append(el('span', { text: msg }));
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, ms);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 非 https / 旧浏览器降级
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  const { getAppPrefix, extractCode, parseImportText, filterAccounts } = window.OutlookPoolCore;
  const APP_PREFIX = getAppPrefix(location.pathname);
  const API_BASE = `${APP_PREFIX}/api`;

  async function api(endpoint, opts = {}) {
    const r = await fetch(`${API_BASE}${endpoint}`, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const isJson = (r.headers.get('content-type') || '').includes('json');
    const data = isJson ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) {
      const msg = (isJson && data.error) ? data.error : `HTTP ${r.status}`;
      const e = new Error(msg);
      e.data = data;
      throw e;
    }
    return data;
  }

  // ---------------- 全局状态 ----------------
  const state = {
    accounts: [],
    filter: 'all',          // all | ok | error | dead | unknown
    search: '',
    selectedId: null,
    folder: 'inbox',
    top: 25,
    messages: [],
    selectedMsgId: null,
    loadingMsgs: false,
    checking: false,
  };

  const layout = $('#layout');
  const setPane = p => { layout.dataset.pane = p; };

  // ---------------- 主题 ----------------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('op-theme', theme);
    $('#themeLabel').textContent = theme === 'light' ? '切换到深色' : '切换到浅色';
  }
  applyTheme(localStorage.getItem('op-theme') || 'dark');
  $('#btnTheme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    closeMenu();
  });

  // ---------------- 账号列表 ----------------
  async function loadAccounts({ silent = false } = {}) {
    const listEl = $('#accountList');
    if (!silent && !state.accounts.length) {
      listEl.replaceChildren(skeleton(6));
    }
    try {
      const j = await api('/accounts');
      state.accounts = j.accounts || [];
      if (state.selectedId && !state.accounts.some(a => a.id === state.selectedId)) {
        state.selectedId = null;
        state.selectedMsgId = null;
        loadMessages._seq++;
        openMessage._seq++;
        renderMessagesEmpty();
        renderDetailEmpty();
        setPane('accounts');
      }
      renderAccounts();
    } catch (e) {
      listEl.replaceChildren(stateBox('⚠️', '加载账号失败', e.message, {
        label: '重试', onClick: () => loadAccounts(),
      }));
    }
  }

  function accountCounts() {
    const c = { all: state.accounts.length, ok: 0, error: 0, dead: 0, unknown: 0 };
    for (const a of state.accounts) c[STATUS[a.status] ? a.status : 'unknown']++;
    return c;
  }

  function renderHeaderStats() {
    const c = accountCounts();
    const parts = [`<b>${c.all}</b> 个账号`];
    const seg = [];
    if (c.ok) seg.push(`<span style="color:var(--ok)">✓${c.ok}</span>`);
    if (c.error) seg.push(`<span style="color:var(--warn)">!${c.error}</span>`);
    if (c.dead) seg.push(`<span style="color:var(--danger)">✕${c.dead}</span>`);
    if (c.unknown) seg.push(`<span style="color:var(--unknown)">?${c.unknown}</span>`);
    $('#headerStats').innerHTML = parts.concat(seg.length ? [`<span class="dot">·</span>${seg.join(' ')}`] : []).join('');
  }

  function renderFilterRow() {
    const c = accountCounts();
    const defs = [
      ['all', '全部', null],
      ['ok', STATUS.ok.label, 'var(--ok)'],
      ['error', STATUS.error.label, 'var(--warn)'],
      ['dead', STATUS.dead.label, 'var(--danger)'],
      ['unknown', STATUS.unknown.label, 'var(--unknown)'],
    ];
    const row = $('#filterRow');
    row.replaceChildren(...defs.map(([key, label, color]) => {
      const chip = el('button', {
        class: `chip${state.filter === key ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': String(state.filter === key),
        onclick: () => { state.filter = key; renderAccounts(); },
      });
      if (color) chip.append(el('span', { class: 'chip-dot', style: `background:${color}` }));
      chip.append(el('span', { text: label }), el('span', { class: 'chip-n', text: String(c[key]) }));
      return chip;
    }));
  }

  function visibleAccounts() {
    return filterAccounts(state.accounts, state.filter, state.search);
  }

  function renderAccounts() {
    renderHeaderStats();
    renderFilterRow();
    const listEl = $('#accountList');
    const rows = visibleAccounts();

    if (!state.accounts.length) {
      listEl.replaceChildren(stateBox('📮', '邮箱池是空的', '点击「批量导入」粘贴账号，格式：邮箱----密码----client_id----refresh_token', {
        label: '批量导入', onClick: openImport, primary: true,
      }));
      return;
    }
    if (!rows.length) {
      listEl.replaceChildren(stateBox('🔍', '没有匹配的账号', '换个筛选条件或搜索词试试'));
      return;
    }

    listEl.replaceChildren(...rows.map(renderAccountItem));
  }

  function renderAccountItem(a) {
    const st = STATUS[a.status] || STATUS.unknown;
    const item = el('div', {
      class: `account-item${a.id === state.selectedId ? ' selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${a.email}，${st.label}`,
      onclick: () => selectAccount(a.id),
      onkeydown: ev => {
        if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          selectAccount(a.id);
        }
      },
    });

    item.append(el('span', { class: `acc-status ${st.cls}`, title: st.label }));

    const main = el('div', { class: 'acc-main' });
    main.append(el('div', { class: 'acc-email', text: a.email, title: a.email }));
    const meta = el('div', { class: 'acc-meta' });
    if ((a.status === 'error' || a.status === 'dead') && a.last_error) {
      meta.append(el('span', {
        class: `err${a.status === 'dead' ? ' dead' : ''}`,
        text: `${st.label} · ${a.last_error}`,
        title: a.last_error,
      }));
    } else {
      meta.append(el('span', {
        text: a.last_check ? `${st.label} · 检查于 ${relTime(a.last_check * 1000)}` : st.label,
        title: a.last_check ? fullTime(a.last_check * 1000) : '',
      }));
    }
    main.append(meta);
    item.append(main);

    const actions = el('div', { class: 'acc-actions' });
    const btnCopy = el('button', { class: 'btn btn-ghost btn-icon', title: '复制邮箱', html: ICONS.copy,
      onclick: async ev => {
        ev.stopPropagation();
        (await copyText(a.email)) ? toast('邮箱已复制', 'ok') : toast('复制失败', 'err');
      } });
    const btnRefresh = el('button', { class: 'btn btn-ghost btn-icon', title: '检查此账号', html: ICONS.refresh,
      onclick: ev => { ev.stopPropagation(); refreshAccount(a, btnRefresh); } });
    const btnDel = el('button', { class: 'btn btn-ghost btn-icon', title: '删除', html: ICONS.trash,
      onclick: ev => { ev.stopPropagation(); deleteAccount(a); } });
    actions.append(btnCopy, btnRefresh, btnDel);
    item.append(actions);
    return item;
  }

  async function refreshAccount(a, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    try {
      const j = await api(`/accounts/${a.id}/refresh`, { method: 'POST' });
      if (j.ok) toast(`${a.email} 正常`, 'ok');
      else toast(`${a.email}：${j.error || '检查失败'}`, 'err', 4000);
    } catch (e) {
      toast(`检查失败：${e.message}`, 'err', 4000);
    }
    await loadAccounts({ silent: true });
  }

  async function deleteAccount(a) {
    if (!confirm(`确认删除 ${a.email}？`)) return;
    try {
      await api(`/accounts/${a.id}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      if (state.selectedId === a.id) {
        loadMessages._seq++;
        openMessage._seq++;
        state.selectedId = null;
        state.selectedMsgId = null;
        state.messages = [];
        renderMessagesEmpty();
        renderDetailEmpty();
        setPane('accounts');
      }
      await loadAccounts({ silent: true });
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    }
  }

  // ---------------- 选择账号 → 邮件列表 ----------------
  function selectAccount(id) {
    if (state.selectedId !== id) {
      loadMessages._seq++;
      openMessage._seq++;
      state.selectedId = id;
      state.selectedMsgId = null;
      state.messages = [];
      renderDetailEmpty();
    }
    renderAccounts();
    setPane('messages');
    loadMessages();
  }

  const selectedAccount = () => state.accounts.find(a => a.id === state.selectedId) || null;

  async function loadMessages({ silent = false } = {}) {
    const acc = selectedAccount();
    if (!acc) return;
    const listEl = $('#messageList');
    const head = $('#msgHead');
    head.hidden = false;
    $('#msgHeadEmail').textContent = acc.email;
    $('#msgHeadEmail').title = acc.email;

    state.loadingMsgs = true;
    if (!silent) listEl.replaceChildren(skeleton(5));
    const reqId = ++loadMessages._seq;
    try {
      const j = await api(`/accounts/${acc.id}/messages?folder=${encodeURIComponent(state.folder)}&top=${state.top}`);
      if (reqId !== loadMessages._seq) return; // 已被更新的请求覆盖
      state.messages = j.messages || [];
      renderMessages();
      loadAccounts({ silent: true }); // 顺带同步状态（读信成功会置 ok）
    } catch (e) {
      if (reqId !== loadMessages._seq) return;
      state.messages = [];
      const dead = e.data && e.data.dead;
      listEl.replaceChildren(stateBox(dead ? '❌' : '⚠️', dead ? 'refresh_token 已失效' : '拉取邮件失败', e.message, {
        label: '重试', onClick: loadMessages,
      }));
      loadAccounts({ silent: true });
    } finally {
      if (reqId === loadMessages._seq) state.loadingMsgs = false;
    }
  }
  loadMessages._seq = 0;

  function renderMessages() {
    const listEl = $('#messageList');
    if (!state.messages.length) {
      listEl.replaceChildren(stateBox('📭', '这里没有邮件', state.folder === 'inbox' ? '收件箱是空的，试试切换到垃圾箱' : '垃圾箱是空的'));
      return;
    }
    listEl.replaceChildren(...state.messages.map(renderMessageItem));
  }

  function renderMessageItem(m) {
    const from = m.from?.emailAddress || {};
    const item = el('div', {
      class: `msg-item${m.isRead === false ? ' unread' : ''}${m.id === state.selectedMsgId ? ' selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${from.name || from.address || '未知发件人'}：${m.subject || '无主题'}`,
      onclick: () => openMessage(m.id),
      onkeydown: ev => {
        if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          openMessage(m.id);
        }
      },
    });

    const row1 = el('div', { class: 'msg-row1' });
    row1.append(
      el('span', { class: 'msg-from', text: from.name || from.address || '(未知发件人)', title: from.address || '' }),
      el('span', { class: 'msg-time', text: relTime(new Date(m.receivedDateTime).getTime()), title: fullTime(new Date(m.receivedDateTime).getTime()) }),
    );
    item.append(row1);
    item.append(el('div', { class: 'msg-subject', text: m.subject || '(无主题)' }));
    if (m.bodyPreview) item.append(el('div', { class: 'msg-preview', text: m.bodyPreview }));

    const code = extractCode(`${m.subject || ''}\n${m.bodyPreview || ''}`);
    if (code) {
      const pill = el('button', { class: 'code-pill', title: '点击复制验证码',
        onclick: async ev => {
          ev.stopPropagation();
          (await copyText(code)) ? toast(`验证码 ${code} 已复制`, 'ok') : toast('复制失败', 'err');
        } });
      pill.innerHTML = ICONS.copy;
      pill.append(el('span', { text: code }));
      item.append(el('div', { class: 'msg-code-row' }, pill));
    }
    return item;
  }

  // ---------------- 正文 ----------------
  async function openMessage(msgId) {
    const acc = selectedAccount();
    if (!acc) return;
    state.selectedMsgId = msgId;
    renderMessages();
    setPane('detail');

    const detail = $('#messageDetail');
    detail.replaceChildren(el('div', { class: 'state' }, el('div', { class: 'spinner' })));
    const reqId = ++openMessage._seq;
    try {
      const j = await api(`/accounts/${acc.id}/messages/${encodeURIComponent(msgId)}`);
      if (reqId !== openMessage._seq) return;
      renderDetail(j);
    } catch (e) {
      if (reqId !== openMessage._seq) return;
      detail.replaceChildren(stateBox('⚠️', '读取正文失败', e.message, {
        label: '重试', onClick: () => openMessage(msgId),
      }));
    }
  }
  openMessage._seq = 0;

  function renderDetail(msg) {
    const detail = $('#messageDetail');
    detail.replaceChildren();

    const head = el('div', { class: 'detail-head' });

    // 移动端返回按钮
    const backRow = el('div', { style: 'margin-bottom:8px' });
    const backBtn = el('button', { class: 'btn btn-ghost btn-sm back-btn', onclick: () => setPane('messages') });
    backBtn.innerHTML = ICONS.back;
    backBtn.append(el('span', { text: '返回列表' }));
    backRow.append(backBtn);
    head.append(backRow);

    head.append(el('h1', { class: 'detail-subject', text: msg.subject || '(无主题)' }));

    const meta = el('dl', { class: 'detail-meta' });
    const from = msg.from?.emailAddress || {};
    meta.append(el('dt', { text: '发件人' }), el('dd', { text: from.name ? `${from.name} <${from.address}>` : (from.address || '—') }));
    const to = (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', ');
    if (to) meta.append(el('dt', { text: '收件人' }), el('dd', { text: to }));
    meta.append(el('dt', { text: '时间' }), el('dd', { text: fullTime(new Date(msg.receivedDateTime).getTime()) }));
    head.append(meta);

    const bodyContent = msg.body?.content || '';
    const code = extractCode(`${msg.subject || ''}\n${bodyContent}`);
    if (code) {
      const bar = el('div', { class: 'detail-codebar' });
      bar.append(el('span', { class: 'label', text: '检测到验证码：' }));
      const pill = el('button', { class: 'code-pill', title: '点击复制',
        onclick: async () => {
          (await copyText(code)) ? toast(`验证码 ${code} 已复制`, 'ok') : toast('复制失败', 'err');
        } });
      pill.innerHTML = ICONS.copy;
      pill.append(el('span', { text: code }));
      bar.append(pill);
      head.append(bar);
    }
    detail.append(head);

    const bodyWrap = el('div', { class: 'detail-body' });
    if (msg.body?.contentType === 'html') {
      // 沙箱 iframe 渲染 HTML 正文，禁脚本
      const frame = el('iframe', { class: 'detail-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
      bodyWrap.append(frame);
      detail.append(bodyWrap);
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>body{margin:16px;font:14px/1.6 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1c2333;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${bodyContent}</body></html>`;
    } else {
      bodyWrap.append(el('div', { class: 'detail-text', text: bodyContent }));
      detail.append(bodyWrap);
    }
  }

  function renderMessagesEmpty() {
    $('#msgHead').hidden = true;
    $('#messageList').replaceChildren(stateBox('👈', '选择一个账号', '从左侧列表点击账号查看它的邮件'));
  }
  function renderDetailEmpty() {
    $('#messageDetail').replaceChildren(stateBox('✉️', '选择一封邮件', '点击邮件列表查看正文，验证码会自动识别'));
  }

  // ---------------- 空态 / 骨架 ----------------
  function stateBox(icon, title, sub, action) {
    const box = el('div', { class: 'state' });
    box.append(el('div', { class: 'state-icon', text: icon }));
    box.append(el('div', { class: 'state-title', text: title }));
    if (sub) box.append(el('div', { class: 'state-sub', text: sub }));
    if (action) {
      box.append(el('button', {
        class: `btn${action.primary ? ' btn-primary' : ''}`,
        text: action.label,
        onclick: action.onClick,
      }));
    }
    return box;
  }

  function skeleton(n) {
    const wrap = el('div', { class: 'skeleton' });
    for (let i = 0; i < n; i++) {
      const row = el('div', { class: 'skel-row' });
      row.append(
        el('div', { class: 'skel-bar', style: `width:${55 + Math.random() * 30}%` }),
        el('div', { class: 'skel-bar', style: `width:${25 + Math.random() * 30}%` }),
      );
      wrap.append(row);
    }
    return wrap;
  }

  // ---------------- 批量导入 ----------------
  function openImport() {
    $('#importResult').hidden = true;
    $('#importMeta').textContent = '';
    $('#importModal').hidden = false;
    setTimeout(() => $('#importText').focus(), 50);
  }

  $('#importText').addEventListener('input', () => {
    const { total, good, bad } = parseImportText($('#importText').value);
    const meta = $('#importMeta');
    if (!total) { meta.textContent = ''; return; }
    meta.innerHTML = `共 ${total} 行，格式正确 ${good} 行` + (bad ? `，<span class="bad">格式异常 ${bad} 行</span>` : '');
  });

  $('#btnImportSubmit').addEventListener('click', async () => {
    const text = $('#importText').value;
    if (!text.trim()) { toast('请先粘贴账号', 'err'); return; }
    const btn = $('#btnImportSubmit');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const j = await api('/accounts/import', { method: 'POST', body: { text } });
      const box = $('#importResult');
      box.hidden = false;
      if (j.bad && j.bad.length) {
        box.className = 'import-result mixed';
        box.replaceChildren(
          el('div', { text: `成功导入 ${j.ok} 个，${j.bad.length} 行被跳过（格式不对）：` }),
          el('pre', { text: j.bad.join('\n') }),
        );
      } else {
        box.className = 'import-result good';
        box.replaceChildren(el('div', { text: `成功导入 ${j.ok} 个账号` }));
      }
      if (j.ok > 0) {
        $('#importText').value = '';
        $('#importMeta').textContent = '';
        toast(`已导入 ${j.ok} 个账号`, 'ok');
        await loadAccounts({ silent: true });
      }
    } catch (e) {
      toast(`导入失败：${e.message}`, 'err', 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = '导入';
    }
  });

  // ---------------- 全部检查（由后端串行执行并节流，避免触发风控） ----------------
  async function checkAll() {
    if (state.checking) return;
    if (!state.accounts.length) { toast('邮箱池是空的', 'err'); return; }
    state.checking = true;
    const btn = $('#btnCheckAll');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>检查中…</span>';
    try {
      const result = await api('/accounts/check-all', { method: 'POST' });
      await loadAccounts({ silent: true });
      toast(
        `检查完成：正常 ${result.ok} · 错误 ${result.error} · 失效 ${result.dead}`,
        result.dead || result.error ? 'err' : 'ok',
        5000,
      );
    } catch (e) {
      toast(`检查失败：${e.message}`, 'err', 4000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      state.checking = false;
    }
  }
  $('#btnCheckAll').addEventListener('click', checkAll);

  // ---------------- 导出 / 清理失效 ----------------
  $('#btnExport').addEventListener('click', async () => {
    closeMenu();
    try {
      const txt = await api('/accounts/export');
      if (!txt || !txt.trim()) { toast('没有可导出的账号', 'err'); return; }
      const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `outlook-pool-${new Date().toISOString().slice(0, 10)}.txt` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast('已导出（含 refresh_token，注意保管）', 'ok', 4000);
    } catch (e) {
      toast(`导出失败：${e.message}`, 'err');
    }
  });

  $('#btnClearDead').addEventListener('click', async () => {
    closeMenu();
    const deadCount = accountCounts().dead;
    if (!deadCount) { toast('没有失效账号', 'ok'); return; }
    if (!confirm(`确认删除全部 ${deadCount} 个失效账号？`)) return;
    try {
      const j = await api('/accounts/clear-dead', { method: 'POST' });
      toast(`已清理 ${j.removed} 个失效账号`, 'ok');
      await loadAccounts({ silent: true });
    } catch (e) {
      toast(`清理失败：${e.message}`, 'err');
    }
  });

  // ---------------- API 文档弹窗 ----------------
  const API_DOCS = [
    { method: 'GET', path: '/api/quick/random', desc: '随机取一个健康邮箱（status 为 ok/unknown）', example: '{ "email": "xx@outlook.com" }' },
    { method: 'GET', path: '/api/quick/latest?email=xx@outlook.com&top=5', desc: '按邮箱地址取最新邮件列表（top 最大 20）', example: '{ "email": "...", "messages": [{ "id", "subject", "from", "received", "preview" }] }' },
    { method: 'GET', path: '/api/quick/code?email=xx@outlook.com&minutes=10&sender=github', desc: '提取最近邮件中的验证码；minutes 限定时间窗，sender 过滤发件人', example: '{ "email": "...", "code": "482913", "subject": "...", "from": "...", "received": "..." }' },
    { method: 'GET', path: '/api/quick/wait-code?email=xx@outlook.com&timeout=60&sender=github', desc: '轮询等待新验证码（timeout 最长 120 秒，适合注册流程接码）', example: '{ "email": "...", "code": "482913", ... }' },
    { method: 'GET', path: '/api/accounts/export', desc: '导出全部账号（原始格式，含 refresh_token）', example: 'email----password----client_id----refresh_token' },
  ];

  function renderApiDocs() {
    const body = $('#apiDocsBody');
    body.replaceChildren(...API_DOCS.map(d => {
      const item = el('div', { class: 'api-item' });
      const row = el('div', { class: 'api-route' });
      row.append(el('span', { class: 'api-method', text: d.method }));
      row.append(el('code', { class: 'api-path', text: d.path }));
      const copyBtn = el('button', { class: 'btn btn-ghost btn-icon api-copy', title: '复制完整 URL', html: ICONS.copy,
        onclick: async () => {
          const url = `${location.origin}${APP_PREFIX}${d.path}`;
          (await copyText(url)) ? toast('URL 已复制', 'ok') : toast('复制失败', 'err');
        } });
      row.append(copyBtn);
      item.append(row);
      item.append(el('p', { class: 'api-desc', text: d.desc }));
      item.append(el('div', { class: 'api-example', text: d.example }));
      return item;
    }));
  }

  // ---------------- 弹窗 & 菜单通用 ----------------
  function closeMenu() {
    $('#moreMenu').hidden = true;
    $('#btnMore').setAttribute('aria-expanded', 'false');
  }
  $('#btnMore').addEventListener('click', ev => {
    ev.stopPropagation();
    const menu = $('#moreMenu');
    menu.hidden = !menu.hidden;
    $('#btnMore').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', ev => {
    if (!ev.target.closest('.menu-wrap')) closeMenu();
  });

  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => { $(`#${b.dataset.close}`).hidden = true; });
  });
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', ev => { if (ev.target === bd) bd.hidden = true; });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(bd => { bd.hidden = true; });
      closeMenu();
    }
  });

  $('#btnImport').addEventListener('click', openImport);
  $('#btnApiDocs').addEventListener('click', () => { closeMenu(); renderApiDocs(); $('#apiModal').hidden = false; });

  // ---------------- 搜索 / 文件夹 / 数量 / 刷新 ----------------
  $('#searchInput').addEventListener('input', ev => {
    state.search = ev.target.value;
    renderAccounts();
  });

  document.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (state.folder === b.dataset.folder) return;
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      state.folder = b.dataset.folder;
      openMessage._seq++;
      state.selectedMsgId = null;
      renderDetailEmpty();
      loadMessages();
    });
  });

  $('#topSelect').addEventListener('change', ev => {
    state.top = parseInt(ev.target.value) || 25;
    loadMessages();
  });

  $('#btnReloadMsgs').addEventListener('click', loadMessages);
  $('#btnBackAccounts').addEventListener('click', () => setPane('accounts'));

  // ---------------- 启动 ----------------
  renderMessagesEmpty();
  renderDetailEmpty();
  loadAccounts();
  // 账号状态轻量轮询（60s）；选中的邮箱每 30s 静默拉取新邮件。
  setInterval(() => { if (!state.checking && !document.hidden) loadAccounts({ silent: true }); }, 60000);
  setInterval(() => {
    if (!state.checking && !document.hidden && state.selectedId) loadMessages({ silent: true });
  }, 30000);
})();
