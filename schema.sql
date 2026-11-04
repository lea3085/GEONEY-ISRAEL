-- גאוני ישראל - סכמת מסד נתונים (Cloudflare D1 / SQLite)
-- כל התאריכים נשמרים כ-epoch באלפיות שנייה (UTC). התאריך העברי מחושב בתצוגה.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  created_at  INTEGER NOT NULL
);

-- בקשות הצטרפות. בעת אישור נוצרת שורה ב-users והמשתמש יכול להיכנס.
CREATE TABLE IF NOT EXISTS join_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL COLLATE NOCASE,
  name        TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_join_status ON join_requests(status, created_at);

-- מערכות
CREATE TABLE IF NOT EXISTS works (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  body_html   TEXT NOT NULL DEFAULT '',
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_works_created ON works(created_at DESC);

-- הערות. עוגן = טווח תווים בטקסט הגלוי של המערכה. אם העוגן נשבר הוא מנוקה וההערה נשארת.
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  author_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  anchor_start  INTEGER,
  anchor_end    INTEGER,
  anchor_text   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_work ON notes(work_id, created_at);

-- תגובות בתוך הערה
CREATE TABLE IF NOT EXISTS replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_note ON replies(note_id, created_at);

-- מעקב: מערכה שלמה או הערה בודדת
CREATE TABLE IF NOT EXISTS follows (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('work','note')),
  target_id    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target_type, target_id);

-- התראות (נכתבות בעת האירוע לכל העוקבים)
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('new_work','new_note','new_reply')),
  work_id     INTEGER,
  note_id     INTEGER,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at DESC);
