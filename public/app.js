/* גאוני ישראל - ממשק (JS רגיל, ללא build) */
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const state = { user: null, config: {}, work: null, pendingJoin: null, unread: 0 };

/* ---------- עזרים ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Asia/Jerusalem';
const hebDate = new Intl.DateTimeFormat('he-u-ca-hebrew', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (ts) => hebDate.format(ts);
const fmtDateTime = (ts) => `${hebDate.format(ts)}, ${timeFmt.format(ts)}`;
const colorOf = (name) => { let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360; return `hsl(${h} 42% 38%)`; };
const avatar = (name, lg = false) => `<span class="avatar${lg ? ' lg' : ''}" style="background:${colorOf(name)}">${esc([...name][0] ?? '?')}</span>`;
const who = (name, ts, withTime = true) =>
  `<div class="who">${avatar(name)}<div><div class="name">${esc(name)}</div><div class="meta">${withTime ? fmtDateTime(ts) : fmtDate(ts)}</div></div></div>`;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* ריק */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || 'שגיאה'), { status: res.status, data });
  return data;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* מתעלמים */ } },
};

/* ---------- ניתוב ---------- */
function nav(path) { history.pushState(null, '', path); render(); window.scrollTo(0, 0); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); nav(a.getAttribute('href')); }
});
window.addEventListener('popstate', render);

const routes = [
  [/^\/$/, homePage], [/^\/w\/(\d+)$/, workPage], [/^\/new$/, newWorkPage],
  [/^\/notifications$/, notifPage], [/^\/admin$/, adminPage], [/^\/join$/, joinPage], [/^\/me$/, mePage],
];
async function render() {
  closeDrawer(); hidePop(); hideSelBtn();
  $('#seo')?.remove();
  renderTopbar();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      try { await fn(...m.slice(1)); } catch (e) { app.innerHTML = `<div class="page"><p class="error">${esc(e.message)}</p></div>`; }
      return;
    }
  }
  app.innerHTML = '<div class="page empty"><h2>הדף לא נמצא</h2><a data-link href="/">חזרה לדף הראשי</a></div>';
}

/* ---------- סרגל עליון וכניסה ---------- */
function renderTopbar() {
  const u = state.user;
  $('#topbar').innerHTML = `
    <a class="brand" data-link href="/">גאוני ישראל</a>
    <nav>
      <a data-link href="/">המערכות</a>
      ${u ? '<a data-link href="/new">מערכה חדשה</a>' : '<a data-link href="/join">בקשת הצטרפות</a>'}
      ${u?.role === 'admin' ? '<a data-link href="/admin">ניהול</a>' : ''}
    </nav>
    <span class="spacer"></span>
    ${u ? `<a class="bell" data-link href="/notifications" title="התראות" aria-label="התראות">🔔${state.unread ? `<span class="badge">${state.unread}</span>` : ''}</a>
      <a data-link href="/me" style="display:flex;align-items:center;gap:8px;color:#f3e6c8">${avatar(u.username)}<span>${esc(u.username)}</span></a>
      <button class="btn ghost small" id="logout" style="color:#f3e6c8;border-color:#6b5a3e">יציאה</button>`
      : '<button class="btn small" id="login">כניסה</button>'}`;
  $('#login')?.addEventListener('click', openLogin);
  $('#logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }); state.user = null; state.unread = 0; toast('יצאת מהמערכת'); render();
  });
}

function openModal(inner) {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="box">${inner}</div>`;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  return m;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

let gsiLoaded;
function loadGsi() {
  gsiLoaded ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = rej; document.head.append(s);
  });
  return gsiLoaded;
}
async function openLogin() {
  const m = openModal(`<h2>כניסה לחברים</h2>
    <p class="muted">הכניסה היא עם חשבון Google. הצפייה באתר פתוחה לכולם; פרסום והגבה שמורים לחברים מאושרים.</p>
    <div id="gbtn" style="min-height:44px;display:flex;justify-content:center"></div>
    <p class="error" id="login-err"></p>
    <p class="muted">עדיין לא חבר? <a data-link href="/join" id="to-join">בקשת הצטרפות</a></p>`);
  $('#to-join', m).addEventListener('click', closeModal);
  if (!state.config.googleClientId) { $('#login-err', m).textContent = 'הכניסה טרם הוגדרה באתר (חסר Google Client ID).'; return; }
  try {
    await loadGsi();
    google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onGoogle });
    google.accounts.id.renderButton($('#gbtn', m), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'he' });
  } catch { $('#login-err', m).textContent = 'לא ניתן לטעון את שירות הכניסה של Google.'; }
}
async function onGoogle(resp) {
  try {
    const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } });
    state.user = r.user; closeModal(); toast(`ברוך הבא, ${r.user.username}`); await refreshUnread(); render();
  } catch (e) {
    if (e.data?.error === 'not_member') {
      state.pendingJoin = { email: e.data.email, name: e.data.name }; closeModal(); toast('החשבון הזה עדיין לא אושר. אפשר לבקש הצטרפות.'); nav('/join');
    } else $('#login-err') && ($('#login-err').textContent = e.message);
  }
}
async function refreshUnread() {
  if (!state.user) return;
  try { state.unread = (await api('/notifications')).unread; renderTopbar(); } catch { /* מתעלמים */ }
}
setInterval(() => { if (!document.hidden && state.user) refreshUnread(); }, 90000);

/* ---------- דף ראשי ---------- */
async function homePage() {
  document.title = 'גאוני ישראל';
  const { works } = await api('/works');
  app.innerHTML = `
    <section class="hero"><h1>גאוני ישראל</h1><p>מערכות, חידושים ודיונים תורניים. עיון, הערות ושיח ענייני במקום אחד.</p></section>
    <div class="page">
      <div class="grid">${works.map(workCard).join('') || '<div class="empty" style="grid-column:1/-1">עדיין לא פורסמו מערכות.</div>'}</div>
    </div>`;
}
const workCard = (w) => `<a class="card" data-link href="/w/${w.id}">
  <h3>${esc(w.title)}</h3><p>${esc(w.description)}</p>
  <div class="foot">${who(w.author, w.created_at, false)}</div></a>`;

/* ---------- דף מערכה ---------- */
const following = new Set();
async function workPage(id) {
  const data = await api(`/works/${id}`);
  state.work = data;
  following.clear(); data.following.forEach((f) => following.add(`${f.target_type}:${f.target_id}`));
  const { work, notes } = data;
  document.title = `${work.title} | גאוני ישראל`;
  const u = state.user;
  const canDelete = u && (u.id === work.author_id || u.role === 'admin');
  app.innerHTML = `<div class="page">
    <div class="work-head">
      <h1>${esc(work.title)}</h1>
      ${who(work.author, work.created_at)}
      <p class="desc">${esc(work.description)}</p>
      <div class="work-actions">
        ${u ? `<button class="btn ghost small" id="follow-work">${following.has('work:' + work.id) ? 'בטל מעקב' : 'עקוב אחרי המערכה'}</button>` : ''}
        ${canDelete ? '<button class="btn danger small" id="del-work">מחק מערכה</button>' : ''}
      </div>
    </div>
    <article class="work-body" id="work-body">${work.body_html}</article>
    <div class="tray-title"><h2 style="margin:0">הערות (${notes.length})</h2>
      ${u ? '<button class="btn small" id="general-note">הערה כללית</button>' : '<span class="muted">רק חברים מאושרים יכולים להגיב</span>'}</div>
    <div class="tray" id="tray">${notes.map(noteCard).join('') || '<div class="muted">אין הערות עדיין. סמנו שורות במערכה כדי להוסיף הערה.</div>'}</div>
  </div>`;
  applyHighlights($('#work-body'), notes);
  bindWork(work);
  const q = Number(new URLSearchParams(location.search).get('note'));
  if (q) openDrawer(q);
}
const validAnchor = (n, text) => n.anchor_start != null && text.slice(n.anchor_start, n.anchor_end) === n.anchor_text;

function noteCard(n) {
  const rc = state.work.replies.filter((r) => r.note_id === n.id).length;
  const hasAnchor = n.anchor_start != null;
  return `<div class="note-card" data-note="${n.id}">
    ${who(n.author, n.created_at)}
    ${hasAnchor ? `<div class="quote">${esc(n.anchor_text.length > 120 ? n.anchor_text.slice(0, 120) + '…' : n.anchor_text)}</div>` : ''}
    <div class="text">${esc(n.content)}</div>
    ${rc ? `<div class="replies-count">${rc} תגובות</div>` : ''}</div>`;
}

function applyHighlights(root, notes) {
  const text = root.textContent;
  const valid = notes.filter((n) => validAnchor(n, text)); // עוגן שנשבר: הסימון מוסר וההערה נשארת
  if (!valid.length) return;
  const bounds = new Set();
  valid.forEach((n) => { bounds.add(n.anchor_start); bounds.add(n.anchor_end); });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  let pos = 0;
  for (const node of nodes) {
    const start = pos, end = pos + node.data.length; pos = end;
    const cuts = [...bounds].filter((b) => b > start && b < end).sort((a, b) => a - b);
    const edges = [start, ...cuts, end];
    const frag = document.createDocumentFragment(); let changed = false;
    for (let i = 0; i < edges.length - 1; i++) {
      const s = edges[i], e = edges[i + 1];
      const piece = node.data.slice(s - start, e - start);
      const ids = valid.filter((n) => n.anchor_start <= s && n.anchor_end >= e).map((n) => n.id);
      if (ids.length) {
        const m = document.createElement('mark'); m.className = 'hl'; m.dataset.notes = ids.join(','); m.textContent = piece; frag.append(m); changed = true;
      } else frag.append(document.createTextNode(piece));
    }
    if (changed) node.replaceWith(frag);
  }
}

function bindWork(work) {
  $('#follow-work')?.addEventListener('click', async () => {
    const on = following.has('work:' + work.id);
    await (on ? api(`/follows?type=work&id=${work.id}`, { method: 'DELETE' }) : api('/follows', { method: 'PUT', body: { type: 'work', id: work.id } }));
    on ? following.delete('work:' + work.id) : following.add('work:' + work.id);
    $('#follow-work').textContent = on ? 'עקוב אחרי המערכה' : 'בטל מעקב'; toast(on ? 'המעקב בוטל' : 'המערכה במעקב');
  });
  $('#del-work')?.addEventListener('click', async () => {
    if (!confirm('למחוק את המערכה על כל ההערות והתגובות שבה? אי אפשר לבטל.')) return;
    await api(`/works/${work.id}`, { method: 'DELETE' }); toast('המערכה נמחקה'); nav('/');
  });
  $('#general-note')?.addEventListener('click', () => composeNote(null));
  $('#tray').addEventListener('click', (e) => {
    const c = e.target.closest('.note-card'); if (c) openDrawer(Number(c.dataset.note));
  });
  const body = $('#work-body');
  const fine = matchMedia('(hover: hover)').matches;
  body.addEventListener('mouseover', (e) => { const m = e.target.closest('mark.hl'); if (m && fine) showPop(m); });
  body.addEventListener('mouseout', (e) => { if (e.target.closest('mark.hl')) schedulePopHide(); });
  body.addEventListener('click', (e) => {
    const m = e.target.closest('mark.hl'); if (!m) return;
    if (fine) openDrawer(Number(m.dataset.notes.split(',')[0])); else showPop(m); // במגע: לחיצה קצרה פותחת תצוגה מקדימה
  });
  document.onselectionchange = onSelection;
}

/* ---------- בחירת טקסט ויצירת הערה מעוגנת ---------- */
function offsetIn(root, node, off) {
  const r = document.createRange(); r.selectNodeContents(root); r.setEnd(node, off); return r.toString().length;
}
let currentSel = null;
function onSelection() {
  const body = $('#work-body'); const sel = getSelection();
  if (!body || !state.user || !sel || sel.isCollapsed || !sel.rangeCount) return hideSelBtn();
  const r = sel.getRangeAt(0);
  if (!body.contains(r.startContainer) || !body.contains(r.endContainer)) return hideSelBtn();
  const start = offsetIn(body, r.startContainer, r.startOffset), end = offsetIn(body, r.endContainer, r.endOffset);
  const text = body.textContent.slice(start, end);
  if (!text.trim() || end <= start) return hideSelBtn();
  currentSel = { start, end, text };
  const rect = r.getBoundingClientRect(); const b = $('#sel-btn');
  b.style.top = `${Math.max(60, rect.top - 46)}px`;
  b.style.left = `${Math.min(innerWidth - 220, Math.max(8, rect.left + rect.width / 2 - 100))}px`;
  b.classList.add('show');
}
function hideSelBtn() { $('#sel-btn').classList.remove('show'); }
$('#sel-btn').addEventListener('mousedown', (e) => e.preventDefault());
$('#sel-btn').addEventListener('click', () => { const s = currentSel; hideSelBtn(); getSelection().removeAllRanges(); if (s) composeNote(s); });

function composeNote(anchor) {
  const m = openModal(`<h2>הערה חדשה</h2>
    ${anchor ? `<div class="thread-note"><div class="quote">${esc(anchor.text.length > 300 ? anchor.text.slice(0, 300) + '…' : anchor.text)}</div></div>` : '<p class="muted">הערה כללית על המערכה.</p>'}
    <form class="form" id="nf"><textarea name="content" placeholder="כתבו את ההערה כאן" required maxlength="5000"></textarea>
    <div class="error" id="nf-err"></div><div style="display:flex;gap:10px"><button class="btn">פרסם</button><button type="button" class="btn ghost" id="nf-cancel">ביטול</button></div></form>`);
  $('#nf-cancel', m).onclick = closeModal; $('textarea', m).focus();
  $('#nf', m).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = { content: new FormData(e.target).get('content') };
      if (anchor) Object.assign(body, { anchor_start: anchor.start, anchor_end: anchor.end, anchor_text: anchor.text });
      const { id } = await api(`/works/${state.work.work.id}/notes`, { method: 'POST', body });
      closeModal(); toast('ההערה פורסמה'); await reloadWork(id);
    } catch (err) { $('#nf-err', m).textContent = err.message; }
  };
}
async function reloadWork(openNote) {
  const id = state.work.work.id; const keep = scrollY;
  await workPage(String(id)); scrollTo(0, keep); if (openNote) openDrawer(openNote);
}

/* ---------- תצוגה מרחפת ---------- */
const pop = $('#pop'); let popTimer;
function showPop(mark) {
  clearTimeout(popTimer);
  const ids = mark.dataset.notes.split(',').map(Number);
  const notes = state.work.notes.filter((n) => ids.includes(n.id));
  pop.innerHTML = notes.map((n) => `<div class="item" data-note="${n.id}">${who(n.author, n.created_at)}<div class="text">${esc(n.content)}</div></div>`).join('');
  const r = mark.getBoundingClientRect();
  pop.style.top = `${Math.min(innerHeight - 280, r.bottom + 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - 350, r.left))}px`;
  pop.classList.add('show');
  mark.classList.add('flash'); pop._mark = mark;
}
function schedulePopHide() { popTimer = setTimeout(hidePop, 250); }
function hidePop() { pop.classList.remove('show'); pop._mark?.classList.remove('flash'); }
pop.addEventListener('mouseenter', () => clearTimeout(popTimer));
pop.addEventListener('mouseleave', schedulePopHide);
pop.addEventListener('click', (e) => { const i = e.target.closest('.item'); if (i) { hidePop(); openDrawer(Number(i.dataset.note)); } });
addEventListener('scroll', () => { if (!matchMedia('(hover: hover)').matches) hidePop(); }, { passive: true });

/* ---------- סרגל צד ---------- */
const drawer = $('#drawer');
const savedW = Number(store.get('drawerW')); if (savedW) drawer.style.setProperty('--drawer-w', `${savedW}px`);
let openNoteId = null;
function openDrawer(noteId) {
  const n = state.work?.notes.find((x) => x.id === noteId); if (!n) return;
  openNoteId = noteId; hidePop();
  const u = state.user;
  const replies = state.work.replies.filter((r) => r.note_id === noteId);
  const canDel = (a) => u && (u.id === a || u.role === 'admin');
  const fol = following.has('note:' + noteId);
  $('#drawer-body').innerHTML = `<div class="thread-note">
      ${who(n.author, n.created_at)}
      ${n.anchor_start != null ? `<div class="quote">${esc(n.anchor_text)}</div>` : ''}
      <div class="text">${esc(n.content)}</div>
      <div class="row-actions">
        ${u ? `<button class="linkish" id="fol-note">${fol ? 'בטל מעקב אחרי הדיון' : 'עקוב אחרי הדיון'}</button>` : ''}
        ${canDel(n.author_id) ? '<button class="linkish danger" id="del-note">מחק הערה</button>' : ''}
      </div></div>
    <h3 style="margin:22px 0 0">תגובות (${replies.length})</h3>
    ${replies.map((r) => `<div class="reply">${who(r.author, r.created_at)}<div class="text">${esc(r.content)}</div>
      ${canDel(r.author_id) ? `<button class="linkish danger" data-del-reply="${r.id}">מחק</button>` : ''}</div>`).join('')}
    ${u ? `<form class="form" id="rf" style="margin-top:16px"><textarea name="content" placeholder="כתבו תגובה" required maxlength="5000" style="min-height:80px"></textarea>
      <div class="error" id="rf-err"></div><div><button class="btn small">שלח תגובה</button></div></form>`
      : '<p class="muted" style="margin-top:16px">רק חברים מאושרים יכולים להגיב.</p>'}`;
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  document.querySelectorAll('mark.hl.flash').forEach((m) => m.classList.remove('flash'));
  document.querySelectorAll('mark.hl').forEach((m) => { if (m.dataset.notes.split(',').includes(String(noteId))) m.classList.add('flash'); });
  const first = document.querySelector(`mark.hl.flash`); first?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  $('#fol-note')?.addEventListener('click', async () => {
    await (fol ? api(`/follows?type=note&id=${noteId}`, { method: 'DELETE' }) : api('/follows', { method: 'PUT', body: { type: 'note', id: noteId } }));
    fol ? following.delete('note:' + noteId) : following.add('note:' + noteId); openDrawer(noteId);
  });
  $('#del-note')?.addEventListener('click', async () => {
    if (!confirm('למחוק את ההערה ואת כל התגובות שבה?')) return;
    await api(`/notes/${noteId}`, { method: 'DELETE' }); closeDrawer(); toast('ההערה נמחקה'); reloadWork();
  });
  document.querySelectorAll('[data-del-reply]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('למחוק את התגובה?')) return;
    await api(`/replies/${b.dataset.delReply}`, { method: 'DELETE' }); toast('התגובה נמחקה'); await reloadWork(noteId);
  }));
  $('#rf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/notes/${noteId}/replies`, { method: 'POST', body: { content: new FormData(e.target).get('content') } });
      toast('התגובה פורסמה'); await reloadWork(noteId);
    } catch (err) { $('#rf-err').textContent = err.message; }
  });
}
function closeDrawer() {
  drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); openNoteId = null;
  document.querySelectorAll('mark.hl.flash').forEach((m) => m.classList.remove('flash'));
}
$('#drawer-close').addEventListener('click', closeDrawer);
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
// שינוי רוחב בגרירה
$('#drawer-grip').addEventListener('pointerdown', (e) => {
  e.preventDefault(); const grip = e.target; grip.setPointerCapture(e.pointerId);
  const move = (ev) => { const w = Math.min(innerWidth * 0.7, Math.max(320, ev.clientX)); drawer.style.setProperty('--drawer-w', `${w}px`); };
  const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); store.set('drawerW', String(Math.round(drawer.offsetWidth))); };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
});

/* ---------- מערכה חדשה ---------- */
async function newWorkPage() {
  if (!state.user) { app.innerHTML = '<div class="page empty"><h2>נדרשת כניסה</h2><p>פרסום מערכות שמור לחברים מאושרים.</p></div>'; return; }
  document.title = 'מערכה חדשה | גאוני ישראל';
  app.innerHTML = `<div class="page"><h1>מערכה חדשה</h1>
    <form class="form" id="wf" style="max-width:860px">
      <label>שם המערכה<input type="text" name="title" required maxlength="150"></label>
      <label>תיאור קצר<textarea name="description" required maxlength="1000" style="min-height:80px"></textarea></label>
      <div><div style="font-weight:500;margin-bottom:6px">גוף המערכה</div>
        <div class="toolbar" id="tb">
          <button type="button" data-cmd="bold"><b>ב</b></button><button type="button" data-cmd="italic"><i>נ</i></button>
          <button type="button" data-cmd="underline"><u>ק</u></button>
          <button type="button" data-block="h2">כותרת</button><button type="button" data-block="h3">כותרת משנה</button>
          <button type="button" data-block="blockquote">ציטוט</button><button type="button" data-block="p">פסקה</button>
          <button type="button" data-cmd="insertUnorderedList">רשימה</button><button type="button" data-cmd="insertOrderedList">מספור</button>
        </div>
        <div class="editor" id="ed" contenteditable="true" dir="rtl" spellcheck="false"></div>
        <div class="muted">הניקוד והתיוו נשמרים. הטקסט אינו ניתן לעריכה לאחר הפרסום (כדי ששיוך ההערות לשורות יישאר מדויק).</div></div>
      <div class="error" id="wf-err"></div>
      <div><button class="btn">פרסם מערכה</button></div></form></div>`;
  const ed = $('#ed');
  $('#tb').addEventListener('mousedown', (e) => e.preventDefault());
  $('#tb').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cmd) document.execCommand(b.dataset.cmd);
    if (b.dataset.block) document.execCommand('formatBlock', false, b.dataset.block);
    ed.focus();
  });
  ed.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  $('#wf').onsubmit = async (e) => {
    e.preventDefault();
    if (!ed.textContent.trim()) { $('#wf-err').textContent = 'גוף המערכה ריק'; return; }
    const f = new FormData(e.target);
    try {
      const { id } = await api('/works', { method: 'POST', body: { title: f.get('title'), description: f.get('description'), body_html: ed.innerHTML } });
      toast('המערכה פורסמה'); nav(`/w/${id}`);
    } catch (err) { $('#wf-err').textContent = err.message; }
  };
}

/* ---------- התראות ומעקב ---------- */
async function notifPage() {
  if (!state.user) { app.innerHTML = '<div class="page empty"><h2>נדרשת כניסה</h2></div>'; return; }
  document.title = 'התראות | גאוני ישראל';
  const [{ items }, fol] = await Promise.all([api('/notifications'), api('/follows')]);
  const text = (n) => n.type === 'new_note'
    ? `הערה חדשה מאת ${esc(n.actor ?? 'משתמש')} במערכה «${esc(n.work_title ?? '')}»`
    : `תגובה חדשה מאת ${esc(n.actor ?? 'משתמש')} בדיון במערכה «${esc(n.work_title ?? '')}»`;
  app.innerHTML = `<div class="page"><h1>התראות</h1>
    <div class="tabs"><button class="active" data-tab="n">עדכונים</button><button data-tab="f">מעקבים שלי</button></div>
    <div id="tab-n"><div style="margin-bottom:12px"><button class="btn ghost small" id="read-all">סמן הכול כנקרא</button></div>
      <div class="list">${items.map((n) => `<a class="list-item ${n.is_read ? '' : 'unread'}" data-link data-nid="${n.id}" href="/w/${n.work_id}?note=${n.note_id ?? ''}">
        <span>${text(n)}</span><span class="muted">${fmtDateTime(n.created_at)}</span></a>`).join('') || '<div class="empty">אין התראות.</div>'}</div></div>
    <div id="tab-f" hidden><div class="list">
      ${fol.works.map((w) => `<div class="list-item"><a data-link href="/w/${w.id}">מערכה: ${esc(w.title)}</a><button class="linkish danger" data-unf="work:${w.id}">בטל מעקב</button></div>`).join('')}
      ${fol.notes.map((n) => `<div class="list-item"><a data-link href="/w/${n.work_id}?note=${n.id}">דיון: ${esc(n.snippet)} <span class="muted">(${esc(n.title)})</span></a><button class="linkish danger" data-unf="note:${n.id}">בטל מעקב</button></div>`).join('')}
      ${!fol.works.length && !fol.notes.length ? '<div class="empty">אינך עוקב אחרי דבר.</div>' : ''}</div></div></div>`;
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('#tab-n').hidden = b.dataset.tab !== 'n'; $('#tab-f').hidden = b.dataset.tab !== 'f';
  }));
  $('#read-all').onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); state.unread = 0; notifPage(); renderTopbar(); };
  document.querySelectorAll('[data-nid]').forEach((a) => a.addEventListener('click', () => {
    api('/notifications/read', { method: 'POST', body: { ids: [Number(a.dataset.nid)] } }).then(refreshUnread);
  }));
  document.querySelectorAll('[data-unf]').forEach((b) => b.addEventListener('click', async () => {
    const [t, id] = b.dataset.unf.split(':'); await api(`/follows?type=${t}&id=${id}`, { method: 'DELETE' }); notifPage();
  }));
  refreshUnread();
}

/* ---------- הצטרפות ופרופיל ---------- */
async function joinPage() {
  document.title = 'בקשת הצטרפות | גאוני ישראל';
  const pj = state.pendingJoin ?? {};
  app.innerHTML = `<div class="page"><h1>בקשת הצטרפות</h1>
    <p>הצפייה באתר פתוחה לכולם. פרסום והגבה שמורים לחברים מאושרים. השאירו פרטים והבקשה תגיע למנהל${state.config.adminEmail ? `, או כתבו ישירות אל <a href="mailto:${esc(state.config.adminEmail)}">${esc(state.config.adminEmail)}</a>` : ''}.</p>
    <form class="form" id="jf"><label>שם<input type="text" name="name" required maxlength="30" value="${esc(pj.name ?? '')}"></label>
    <label>כתובת מייל (חשבון Google שבו תיכנסו)<input type="email" name="email" required value="${esc(pj.email ?? '')}"></label>
    <label>כמה מילים עליכם (לא חובה)<textarea name="message" maxlength="500"></textarea></label>
    <div class="error" id="jf-err"></div><div><button class="btn">שלח בקשה</button></div></form></div>`;
  $('#jf').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      await api('/join', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), message: f.get('message') } });
      app.innerHTML = '<div class="page empty"><h2>הבקשה נשלחה</h2><p>תודה. המנהל יבדוק את הבקשה. לאחר האישור אפשר להיכנס עם חשבון Google שצוין.</p></div>';
    } catch (err) { $('#jf-err').textContent = err.message; }
  };
}
async function mePage() {
  if (!state.user) { app.innerHTML = '<div class="page empty"><h2>נדרשת כניסה</h2></div>'; return; }
  document.title = 'הפרופיל שלי | גאוני ישראל';
  app.innerHTML = `<div class="page"><h1>הפרופיל שלי</h1><div style="display:flex;gap:14px;align-items:center;margin-bottom:18px">${avatar(state.user.username, true)}<div class="muted">${esc(state.user.email)}</div></div>
    <form class="form" id="pf" style="max-width:420px"><label>שם משתמש (אפשר לשנות בכל עת)<input type="text" name="username" required maxlength="30" value="${esc(state.user.username)}"></label>
    <div class="error" id="pf-err"></div><div><button class="btn">שמור</button></div></form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try { state.user = (await api('/me', { method: 'PATCH', body: { username: new FormData(e.target).get('username') } })).user; toast('השם עודכן'); render(); }
    catch (err) { $('#pf-err').textContent = err.message; }
  };
}

/* ---------- ניהול ---------- */
async function adminPage() {
  if (state.user?.role !== 'admin') { app.innerHTML = '<div class="page empty"><h2>אין הרשאה</h2></div>'; return; }
  document.title = 'ניהול | גאוני ישראל';
  const [{ requests }, { users }] = await Promise.all([api('/admin/requests'), api('/admin/users')]);
  const st = { pending: 'ממתינה', approved: 'אושרה', rejected: 'נדחתה' };
  app.innerHTML = `<div class="page"><h1>ניהול</h1>
    <h2>בקשות הצטרפות</h2><div class="list">${requests.map((r) => `<div class="list-item"><div><b>${esc(r.name)}</b> · ${esc(r.email)} <span class="muted">(${st[r.status]}, ${fmtDate(r.created_at)})</span>
      ${r.message ? `<div class="muted">${esc(r.message)}</div>` : ''}</div>
      ${r.status === 'pending' ? `<div style="display:flex;gap:8px"><button class="btn small" data-act="approve" data-id="${r.id}">אשר</button><button class="btn ghost small" data-act="reject" data-id="${r.id}">דחה</button></div>` : ''}</div>`).join('') || '<div class="muted">אין בקשות.</div>'}</div>
    <h2 style="margin-top:36px">חברים</h2><div class="list">${users.map((u) => `<div class="list-item"><div>${who(u.username, u.created_at, false)}<span class="muted">${esc(u.email)}</span></div>
      <div style="display:flex;gap:10px;align-items:center"><span>${u.role === 'admin' ? 'מנהל' : 'חבר'}</span>
      ${u.id !== state.user.id ? `<button class="linkish" data-role="${u.id}:${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'הפוך לחבר' : 'הפוך למנהל'}</button><button class="linkish danger" data-deluser="${u.id}">הסר חבר</button>` : ''}</div></div>`).join('')}</div>
    <p class="muted" style="margin-top:24px">מחיקת מערכות, הערות ותגובות בודדות: מתוך דף המערכה והסרגל הצדדי (למנהל מופיע כפתור מחיקה בכל פריט).</p></div>`;
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/admin/requests/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' }); toast('עודכן'); adminPage();
  }));
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => {
    const [id, role] = b.dataset.role.split(':'); await api(`/admin/users/${id}`, { method: 'PATCH', body: { role } }); adminPage();
  }));
  document.querySelectorAll('[data-deluser]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('להסיר את החבר ולמחוק את כל התוכן שיצר (מערכות, הערות ותגובות)? אי אפשר לבטל.')) return;
    await api(`/admin/users/${b.dataset.deluser}`, { method: 'DELETE' }); toast('החבר הוסר'); adminPage();
  }));
}

/* ---------- אתחול ---------- */
(async function boot() {
  try { state.config = await api('/config'); } catch { /* ממשיכים */ }
  try { state.user = (await api('/me')).user; } catch { /* אורח */ }
  await refreshUnread();
  render();
})();
