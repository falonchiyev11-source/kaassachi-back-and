import pg from 'pg';

// int8 (bigint) qiymatlarni JS number sifatida qaytaramiz (so'm summalari 2^53 dan ancha kichik)
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));
// int8[] (navbat ID'lari) ham son massivi bo'lsin
const parseBigintArray = pg.types.getTypeParser(1016);
pg.types.setTypeParser(1016, v => (v === null ? null : parseBigintArray(v).map(x => (x === null ? null : Number(x)))));
// date ustunini "YYYY-MM-DD" satri sifatida qoldiramiz (vaqt zonasi siljishisiz)
pg.types.setTypeParser(1082, v => v);

function connectionString() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL topilmadi');
  const u = new URL(raw);
  // SSL'ni pastda aniq yoqamiz; libpq'ga xos parametrlarni olib tashlaymiz
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  return u.toString();
}

export const pool = new pg.Pool({
  connectionString: connectionString(),
  ssl: { rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 30000,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  tg_username TEXT,
  phone TEXT,
  photo TEXT,
  registered BOOLEAN NOT NULL DEFAULT FALSE,
  notif JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone);

CREATE TABLE IF NOT EXISTS cards (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  first4 TEXT NOT NULL,
  last4 TEXT NOT NULL,
  holder TEXT NOT NULL,
  exp TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  image TEXT,
  size INT NOT NULL CHECK (size BETWEEN 4 AND 12),
  amount BIGINT NOT NULL CHECK (amount > 0),
  period TEXT NOT NULL CHECK (period IN ('weekly','monthly')),
  start_date DATE NOT NULL,
  queue_method TEXT NOT NULL CHECK (queue_method IN ('lottery','manual','random')),
  status TEXT NOT NULL DEFAULT 'forming',
  order_ids BIGINT[],
  draft_order BIGINT[],
  order_locked BOOLEAN NOT NULL DEFAULT FALSE,
  current_round INT NOT NULL DEFAULT -1,
  creator_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS members (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'invited',
  offline BOOLEAN NOT NULL DEFAULT FALSE,
  pay_method TEXT NOT NULL DEFAULT 'cash',
  autopay BOOLEAN NOT NULL DEFAULT FALSE,
  card_id BIGINT REFERENCES cards(id) ON DELETE SET NULL,
  last_read_msg BIGINT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS members_group_idx ON members (group_id);
CREATE INDEX IF NOT EXISTS members_user_idx ON members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS members_group_user_uq ON members (group_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rounds (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  recipient_member_id BIGINT NOT NULL REFERENCES members(id),
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_out_at TIMESTAMPTZ,
  reminded BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (group_id, idx)
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  member_id BIGINT NOT NULL REFERENCES members(id),
  amount BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  method TEXT,
  claimed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  UNIQUE (round_id, member_id)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id BIGINT REFERENCES members(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  text TEXT,
  kind TEXT,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  duration TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_group_idx ON messages (group_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon TEXT,
  title TEXT NOT NULL,
  sub TEXT,
  amount BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_idx ON activity (user_id, id DESC);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
