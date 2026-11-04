import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Role = 'member' | 'admin';
type User = { id: number; email: string; username: string; role: Role };
type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  ADMIN_EMAIL: string;
  SESSION_SECRET: string;
  TURNSTILE_SECRET?: string;
};
type Env = { Bindings: Bindings; Variables: { user: User | null } };

const app = new Hono<Env>();
const SESSION_DAYS = 30;
const enc = new TextEncoder();

/* ---------- עזרים ---------- */
const now = () => Date.now();

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str: string): Uint8Array {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signSession(uid: number, secret: string): Promise<string> {
  const exp = now() + SESSION_DAYS * 86400000;
  const payload = `${uid}.${exp}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64urlEncode(sig)}`;
}
async function readSession(token: string | undefined, secret: string): Promise<number | null> {
  if (!token || !secret) return null;
  const [uid, exp, sig] = token.split('.');
  if (!uid || !exp || !sig) return null;
  if (Number(exp) < now()) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(`${uid}.${exp}`));
  return ok ? Number(uid) : null;
}

/* ניקוי HTML: רשימה לבנה של תגיות, ללא שום מאפיינים. */
const ALLOWED = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li']);
const TAG_MAP: Record<string, string> = { b: 'strong', i: 'em', div: 'p' };
export function sanitizeHtml(input: string): string {
  const parts = input.split(/(<[^>]*>)/g);
  let out = '';
  for (const part of parts) {
    if (part.startsWith('<') && part.endsWith('>')) {
      const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(part);
      if (!m) continue;
      let tag = m[2].toLowerCase();
      tag = TAG_MAP[tag] ?? tag;
      if (!ALLOWED.has(tag)) continue;
      out += m[1] ? `</${tag}>` : tag === 'br' ? '<br>' : `<${tag}>`;
    } else {
      out += part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }
  return out;
}
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cleanName(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 30) return null;
  if (/[<>"&\u0000-\u001f]/.test(t)) return null;
  return t;
}
const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function uniqueUsername(db: D1Database, base: string): Promise<string> {
  let name = cleanName(base) ?? 'חבר';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? name : `${name}${i + 1}`.slice(0, 30);
    const row = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(candidate).first();
    if (!row) return candidate;
  }
  return `${name}${Math.floor(Math.random() * 100000)}`.slice(0, 30);
}

/* ---------- אימות Google ---------- */
async function verifyGoogleIdToken(token: string, clientId: string) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('bad token');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  const jwks = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('bad iss');
  if (payload.aud !== clientId) throw new Error('bad aud');
  if (payload.exp * 1000 < now()) throw new Error('expired');
  if (!payload.email_verified) throw new Error('email not verified');
  return { email: String(payload.email).toLowerCase(), name: String(payload.name ?? '') };
}

/* ---------- middleware ---------- */
app.use('*', async (c, next) => {
  // הגנת CSRF בסיסית: בקשות שמשנות מצב חייבות להגיע מאותו מקור
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'forbidden' }, 403);
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  const uid = await readSession(getCookie(c, 'sid'), c.env.SESSION_SECRET);
  let user: User | null = null;
  if (uid) {
    user = await c.env.DB.prepare('SELECT id, email, username, role FROM users WHERE id = ?').bind(uid).first<User>();
  }
  c.set('user', user);
  await next();
});

const needUser = (c: any): User | Response => c.get('user') ?? c.json({ error: 'נדרשת כניסה' }, 401);
const isResponse = (x: unknown): x is Response => x instanceof Response;
const needAdmin = (c: any): User | Response => {
  const u = c.get('user') as User | null;
  if (!u) return c.json({ error: 'נדרשת כניסה' }, 401);
  if (u.role !== 'admin') return c.json({ error: 'אין הרשאה' }, 403);
  return u;
};

/* ---------- ציבורי ---------- */
app.get('/api/config', (c) =>
  c.json({ googleClientId: c.env.GOOGLE_CLIENT_ID, adminEmail: c.env.ADMIN_EMAIL, turnstileSiteKey: null }),
);

app.get('/api/me', (c) => c.json({ user: c.get('user') }));

app.get('/api/works', async (c) => {
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.title, w.description, w.created_at, u.username AS author
     FROM works w JOIN users u ON u.id = w.author_id
     ORDER BY w.created_at DESC LIMIT 30 OFFSET ?`,
  ).bind(offset).all();
  return c.json({ works: rows.results });
});

app.get('/api/works/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  const db = c.env.DB;
  const work = await db
    .prepare(
      `SELECT w.id, w.title, w.description, w.body_html, w.created_at, w.author_id, u.username AS author
       FROM works w JOIN users u ON u.id = w.author_id WHERE w.id = ?`,
    )
    .bind(id)
    .first();
  if (!work) return c.json({ error: 'לא נמצא' }, 404);
  const [notes, replies] = await Promise.all([
    db
      .prepare(
        `SELECT n.id, n.content, n.anchor_start, n.anchor_end, n.anchor_text, n.created_at, n.author_id, u.username AS author
         FROM notes n JOIN users u ON u.id = n.author_id WHERE n.work_id = ? ORDER BY n.created_at`,
      )
      .bind(id)
      .all(),
    db
      .prepare(
        `SELECT r.id, r.note_id, r.content, r.created_at, r.author_id, u.username AS author
         FROM replies r JOIN users u ON u.id = r.author_id
         WHERE r.note_id IN (SELECT id FROM notes WHERE work_id = ?) ORDER BY r.created_at`,
      )
      .bind(id)
      .all(),
  ]);
  let following: { target_type: string; target_id: number }[] = [];
  if (user) {
    const f = await db
      .prepare(
        `SELECT target_type, target_id FROM follows WHERE user_id = ?1 AND (
           (target_type = 'work' AND target_id = ?2) OR
           (target_type = 'note' AND target_id IN (SELECT id FROM notes WHERE work_id = ?2)))`,
      )
      .bind(user.id, id)
      .all<{ target_type: string; target_id: number }>();
    following = f.results;
  }
  return c.json({ work, notes: notes.results, replies: replies.results, following });
});

app.post('/api/join', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'בקשה לא תקינה' }, 400);
  const name = cleanName(body.name);
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : '';
  if (!name || !isEmail(body.email)) return c.json({ error: 'יש למלא שם ומייל תקינים' }, 400);
  const email = body.email.toLowerCase();

  if (c.env.TURNSTILE_SECRET) {
    const form = new FormData();
    form.append('secret', c.env.TURNSTILE_SECRET);
    form.append('response', String(body.turnstile ?? ''));
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j = (await r.json()) as { success: boolean };
    if (!j.success) return c.json({ error: 'אימות האנושיות נכשל' }, 400);
  }

  const db = c.env.DB;
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    return c.json({ error: 'המייל הזה כבר רשום. אפשר להיכנס.' }, 409);
  if (await db.prepare("SELECT 1 FROM join_requests WHERE email = ? AND status = 'pending'").bind(email).first())
    return c.json({ ok: true });
  await db
    .prepare('INSERT INTO join_requests (email, name, message, created_at) VALUES (?, ?, ?, ?)')
    .bind(email, name, message, now())
    .run();
  return c.json({ ok: true });
});

/* ---------- כניסה ---------- */
app.post('/api/auth/google', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.credential || !c.env.GOOGLE_CLIENT_ID) return c.json({ error: 'בקשה לא תקינה' }, 400);
  let info: { email: string; name: string };
  try {
    info = await verifyGoogleIdToken(body.credential, c.env.GOOGLE_CLIENT_ID);
  } catch {
    return c.json({ error: 'אימות הכניסה נכשל' }, 401);
  }
  const db = c.env.DB;
  let user = await db.prepare('SELECT id, email, username, role FROM users WHERE email = ?').bind(info.email).first<User>();
  if (!user && c.env.ADMIN_EMAIL && info.email === c.env.ADMIN_EMAIL.toLowerCase()) {
    const username = await uniqueUsername(db, info.name || 'מנהל');
    await db.prepare("INSERT INTO users (email, username, role, created_at) VALUES (?, ?, 'admin', ?)").bind(info.email, username, now()).run();
    user = await db.prepare('SELECT id, email, username, role FROM users WHERE email = ?').bind(info.email).first<User>();
  }
  if (!user) return c.json({ error: 'not_member', email: info.email, name: info.name }, 403);
  const token = await signSession(user.id, c.env.SESSION_SECRET);
  setCookie(c, 'sid', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
  return c.json({ user });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

app.patch('/api/me', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const body = await c.req.json().catch(() => null);
  const name = cleanName(body?.username);
  if (!name) return c.json({ error: 'שם משתמש: 2 עד 30 תווים, בלי תווים מיוחדים' }, 400);
  const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(name, u.id).first();
  if (taken) return c.json({ error: 'השם תפוס' }, 409);
  await c.env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, u.id).run();
  return c.json({ user: { ...u, username: name } });
});

/* ---------- מערכות ---------- */
app.post('/api/works', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const body = await c.req.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const html = sanitizeHtml(typeof body?.body_html === 'string' ? body.body_html : '');
  if (!title || title.length > 150) return c.json({ error: 'שם המערכה חובה (עד 150 תווים)' }, 400);
  if (!description || description.length > 1000) return c.json({ error: 'תיאור חובה (עד 1000 תווים)' }, 400);
  if (html.length > 200000) return c.json({ error: 'המערכה ארוכה מדי' }, 400);
  const t = now();
  const res = await c.env.DB.prepare('INSERT INTO works (title, description, body_html, author_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(title, description, html, u.id, t)
    .run();
  const id = res.meta.last_row_id;
  await c.env.DB.prepare("INSERT OR IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, 'work', ?, ?)").bind(u.id, id, t).run();
  return c.json({ id });
});

app.delete('/api/works/:id', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  const w = await c.env.DB.prepare('SELECT author_id FROM works WHERE id = ?').bind(id).first<{ author_id: number }>();
  if (!w) return c.json({ error: 'לא נמצא' }, 404);
  if (w.author_id !== u.id && u.role !== 'admin') return c.json({ error: 'אין הרשאה' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM follows WHERE target_type = 'note' AND target_id IN (SELECT id FROM notes WHERE work_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM follows WHERE target_type = 'work' AND target_id = ?").bind(id),
    c.env.DB.prepare('DELETE FROM notifications WHERE work_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM works WHERE id = ?').bind(id), // הערות ותגובות נמחקות בשרשרת
  ]);
  return c.json({ ok: true });
});

/* ---------- הערות ותגובות ---------- */
app.post('/api/works/:id/notes', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const workId = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > 5000) return c.json({ error: 'תוכן ההערה חובה (עד 5000 תווים)' }, 400);
  if (!(await c.env.DB.prepare('SELECT 1 FROM works WHERE id = ?').bind(workId).first())) return c.json({ error: 'לא נמצא' }, 404);

  let a0: number | null = null, a1: number | null = null, aText: string | null = null;
  if (Number.isInteger(body?.anchor_start) && Number.isInteger(body?.anchor_end)) {
    if (body.anchor_start >= 0 && body.anchor_end > body.anchor_start && body.anchor_end <= 500000 && typeof body.anchor_text === 'string') {
      a0 = body.anchor_start;
      a1 = body.anchor_end;
      aText = body.anchor_text.slice(0, 2000);
    }
  }
  const t = now();
  const res = await c.env.DB.prepare('INSERT INTO notes (work_id, author_id, content, anchor_start, anchor_end, anchor_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(workId, u.id, content, a0, a1, aText, t)
    .run();
  const noteId = res.meta.last_row_id;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, 'note', ?, ?)").bind(u.id, noteId, t),
    c.env.DB.prepare(
      `INSERT INTO notifications (user_id, type, work_id, note_id, actor_id, created_at)
       SELECT user_id, 'new_note', ?1, ?2, ?3, ?4 FROM follows
       WHERE target_type = 'work' AND target_id = ?1 AND user_id != ?3`,
    ).bind(workId, noteId, u.id, t),
  ]);
  return c.json({ id: noteId });
});

app.delete('/api/notes/:id', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  const n = await c.env.DB.prepare('SELECT author_id FROM notes WHERE id = ?').bind(id).first<{ author_id: number }>();
  if (!n) return c.json({ error: 'לא נמצא' }, 404);
  if (n.author_id !== u.id && u.role !== 'admin') return c.json({ error: 'אין הרשאה' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM follows WHERE target_type = 'note' AND target_id = ?").bind(id),
    c.env.DB.prepare('DELETE FROM notifications WHERE note_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id), // תגובות נמחקות בשרשרת
  ]);
  return c.json({ ok: true });
});

app.post('/api/notes/:id/replies', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const noteId = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > 5000) return c.json({ error: 'תוכן התגובה חובה (עד 5000 תווים)' }, 400);
  const note = await c.env.DB.prepare('SELECT work_id FROM notes WHERE id = ?').bind(noteId).first<{ work_id: number }>();
  if (!note) return c.json({ error: 'לא נמצא' }, 404);
  const t = now();
  const res = await c.env.DB.prepare('INSERT INTO replies (note_id, author_id, content, created_at) VALUES (?, ?, ?, ?)').bind(noteId, u.id, content, t).run();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, 'note', ?, ?)").bind(u.id, noteId, t),
    c.env.DB.prepare(
      `INSERT INTO notifications (user_id, type, work_id, note_id, actor_id, created_at)
       SELECT DISTINCT user_id, 'new_reply', ?1, ?2, ?3, ?4 FROM follows
       WHERE ((target_type = 'note' AND target_id = ?2) OR (target_type = 'work' AND target_id = ?1)) AND user_id != ?3`,
    ).bind(note.work_id, noteId, u.id, t),
  ]);
  return c.json({ id: res.meta.last_row_id });
});

app.delete('/api/replies/:id', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  const r = await c.env.DB.prepare('SELECT author_id FROM replies WHERE id = ?').bind(id).first<{ author_id: number }>();
  if (!r) return c.json({ error: 'לא נמצא' }, 404);
  if (r.author_id !== u.id && u.role !== 'admin') return c.json({ error: 'אין הרשאה' }, 403);
  await c.env.DB.prepare('DELETE FROM replies WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

/* ---------- מעקב והתראות ---------- */
app.put('/api/follows', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const b = await c.req.json().catch(() => null);
  if (!['work', 'note'].includes(b?.type) || !Number.isInteger(b?.id)) return c.json({ error: 'בקשה לא תקינה' }, 400);
  await c.env.DB.prepare('INSERT OR IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').bind(u.id, b.type, b.id, now()).run();
  return c.json({ ok: true });
});

app.delete('/api/follows', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const type = c.req.query('type');
  const id = Number(c.req.query('id'));
  if (!['work', 'note'].includes(type ?? '') || !Number.isInteger(id)) return c.json({ error: 'בקשה לא תקינה' }, 400);
  await c.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND target_type = ? AND target_id = ?').bind(u.id, type, id).run();
  return c.json({ ok: true });
});

app.get('/api/follows', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const works = await c.env.DB.prepare(
    `SELECT w.id, w.title FROM follows f JOIN works w ON w.id = f.target_id WHERE f.user_id = ? AND f.target_type = 'work' ORDER BY f.created_at DESC`,
  ).bind(u.id).all();
  const notes = await c.env.DB.prepare(
    `SELECT n.id, n.work_id, substr(n.content, 1, 80) AS snippet, w.title
     FROM follows f JOIN notes n ON n.id = f.target_id JOIN works w ON w.id = n.work_id
     WHERE f.user_id = ? AND f.target_type = 'note' ORDER BY f.created_at DESC`,
  ).bind(u.id).all();
  return c.json({ works: works.results, notes: notes.results });
});

app.get('/api/notifications', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const items = await c.env.DB.prepare(
    `SELECT nt.id, nt.type, nt.work_id, nt.note_id, nt.is_read, nt.created_at,
            a.username AS actor, w.title AS work_title
     FROM notifications nt
     LEFT JOIN users a ON a.id = nt.actor_id
     LEFT JOIN works w ON w.id = nt.work_id
     WHERE nt.user_id = ? ORDER BY nt.created_at DESC LIMIT 50`,
  ).bind(u.id).all();
  const unread = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').bind(u.id).first<{ n: number }>();
  return c.json({ items: items.results, unread: unread?.n ?? 0 });
});

app.post('/api/notifications/read', async (c) => {
  const u = needUser(c);
  if (isResponse(u)) return u;
  const b = await c.req.json().catch(() => ({}));
  if (Array.isArray(b?.ids) && b.ids.length) {
    const ids = b.ids.filter(Number.isInteger).slice(0, 100);
    if (ids.length) {
      await c.env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(u.id, ...ids).run();
    }
  } else {
    await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(u.id).run();
  }
  return c.json({ ok: true });
});

/* ---------- ניהול ---------- */
app.get('/api/admin/requests', async (c) => {
  const u = needAdmin(c);
  if (isResponse(u)) return u;
  const rows = await c.env.DB.prepare("SELECT id, email, name, message, status, created_at FROM join_requests ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200").all();
  return c.json({ requests: rows.results });
});

app.post('/api/admin/requests/:id/:action', async (c) => {
  const u = needAdmin(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');
  const db = c.env.DB;
  const r = await db.prepare("SELECT email, name FROM join_requests WHERE id = ? AND status = 'pending'").bind(id).first<{ email: string; name: string }>();
  if (!r) return c.json({ error: 'הבקשה לא נמצאה או כבר טופלה' }, 404);
  if (action === 'approve') {
    if (!(await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(r.email).first())) {
      const username = await uniqueUsername(db, r.name);
      await db.prepare("INSERT INTO users (email, username, role, created_at) VALUES (?, ?, 'member', ?)").bind(r.email, username, now()).run();
    }
    await db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").bind(id).run();
  } else if (action === 'reject') {
    await db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").bind(id).run();
  } else return c.json({ error: 'פעולה לא מוכרת' }, 400);
  return c.json({ ok: true });
});

app.get('/api/admin/users', async (c) => {
  const u = needAdmin(c);
  if (isResponse(u)) return u;
  const rows = await c.env.DB.prepare('SELECT id, email, username, role, created_at FROM users ORDER BY created_at').all();
  return c.json({ users: rows.results });
});

app.patch('/api/admin/users/:id', async (c) => {
  const u = needAdmin(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => null);
  if (!['member', 'admin'].includes(b?.role)) return c.json({ error: 'תפקיד לא תקין' }, 400);
  if (id === u.id) return c.json({ error: 'אי אפשר לשנות את התפקיד של עצמך' }, 400);
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run();
  return c.json({ ok: true });
});

app.delete('/api/admin/users/:id', async (c) => {
  const u = needAdmin(c);
  if (isResponse(u)) return u;
  const id = Number(c.req.param('id'));
  if (id === u.id) return c.json({ error: 'אי אפשר למחוק את עצמך' }, 400);
  // כל התוכן של המשתמש נמחק בשרשרת (מערכות, הערות, תגובות, מעקבים, התראות)
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM follows WHERE target_type = 'work' AND target_id IN (SELECT id FROM works WHERE author_id = ?1)").bind(id),
    c.env.DB.prepare("DELETE FROM follows WHERE target_type = 'note' AND target_id IN (SELECT id FROM notes WHERE author_id = ?1 OR work_id IN (SELECT id FROM works WHERE author_id = ?1))").bind(id),
    c.env.DB.prepare('DELETE FROM notifications WHERE work_id IN (SELECT id FROM works WHERE author_id = ?1)').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/* ---------- דף מערכה עם רינדור בצד השרת (SEO) ---------- */
app.get('/w/:id', async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
  let html = await res.text();
  const id = Number(c.req.param('id'));
  const w = await c.env.DB.prepare(
    'SELECT w.title, w.description, w.body_html FROM works w WHERE w.id = ?',
  ).bind(id).first<{ title: string; description: string; body_html: string }>();
  if (w) {
    const title = `${esc(w.title)} | גאוני ישראל`;
    html = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
      .replace('<!--SEO_META-->', `<meta name="description" content="${esc(w.description)}"><meta property="og:title" content="${esc(w.title)}"><meta property="og:description" content="${esc(w.description)}"><meta property="og:type" content="article">`)
      .replace('<!--SEO_BODY-->', `<article id="seo"><h1>${esc(w.title)}</h1><p>${esc(w.description)}</p><div>${w.body_html}</div></article>`);
  }
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
});

export default app;
