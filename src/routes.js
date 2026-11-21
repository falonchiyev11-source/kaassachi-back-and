import express from 'express';
import { pool, q, tx } from './db.js';
import {
  bad, forbidden, notFound, normPhone, randomCode, randomId, parseDataURL, shuffle, money, PERIOD, todayISO,
} from './util.js';
import {
  newCtx, flush, loadGroup, toClient, sys, activity, notify, notifyGroup, checkFull, lockOrder, startGroup,
  claimCash, markPaid, member,
} from './engine.js';
import { BOT_USERNAME, inviteLink, tg } from './bot.js';

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const NOTIF_DEFAULT = { invited: true, full: true, lottery: true, queue: true, due: true, paid: true, received: true, turn: true, completed: true };
const fullName = u => `${u.first_name} ${u.last_name}`.trim();
const MEDIA_LIMIT = { image: 6 * 1048576, video: 16 * 1048576, voice: 6 * 1048576 };

function userOut(u) {
  return {
    id: u.id, firstName: u.first_name, lastName: u.last_name, username: u.username, tgUsername: u.tg_username,
    phone: u.phone, photo: u.photo, registered: u.registered, notif: { ...NOTIF_DEFAULT, ...(u.notif || {}) },
  };
}

// Tranzaksiya ichida amal + keyin Telegram xabarlarini yuborish
async function act(fn) {
  const ctx = newCtx();
  const out = await tx(c => fn(c, ctx));
  flush(ctx).catch(e => console.warn('[flush]', e.message));
  return out;
}

async function groupFor(c, gid, user, { lock = false, owner = false } = {}) {
  const g = await loadGroup(c, Number(gid), lock);
  if (!g) throw notFound('Guruh topilmadi');
  const mine = g.members.find(m => m.user_id === user.id);
  if (!mine) throw forbidden('Siz bu guruh a’zosi emassiz');
  if (owner && g.creator_id !== user.id) throw forbidden('Bu amalni faqat guruh yaratuvchisi bajaradi');
  g.mine = mine;
  return g;
}

function validName(s, label) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 40) throw bad(`${label}ni kiriting (2–40 belgi)`);
  return s;
}

/* ---------------- Ochiq yo'llar (auth talab qilmaydi) */
export const publicRouter = express.Router();
publicRouter.get('/config', (req, res) => res.json({ botUsername: BOT_USERNAME }));
publicRouter.get('/media/:id', wrap(async (req, res) => {
  const { rows } = await q('SELECT mime, data FROM media WHERE id=$1', [String(req.params.id).slice(0, 64)]);
  if (!rows[0]) return res.sendStatus(404);
  res.set('Content-Type', rows[0].mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(rows[0].data);
}));

/* ---------------- Himoyalangan yo'llar */
export const router = express.Router();

/* --- Profil */
router.get('/me', (req, res) => res.json(userOut(req.user)));

async function saveProfile(req, register) {
  const b = req.body || {};
  const first = validName(b.firstName, 'Ism');
  const last = validName(b.lastName, 'Familiya');
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{4,20}$/.test(username)) throw bad('Username 4–20 belgi: lotin harflari, raqam yoki “_”');
  let phone = req.user.phone;
  if (b.phone !== undefined && b.phone !== null && b.phone !== '') {
    phone = normPhone(b.phone);
    if (!phone) throw bad('Telefon raqami +998 XX XXX XX XX ko‘rinishida bo‘lsin');
  }
  if (register && !phone) throw bad('Telefon raqamini kiriting yoki Telegram orqali ulashing');
  let photo = req.user.photo;
  if (b.photo === null) photo = null;
  else if (typeof b.photo === 'string' && b.photo.startsWith('data:')) {
    parseDataURL(b.photo, 400 * 1024);
    photo = b.photo;
  }
  try {
    const { rows } = await q(
      `UPDATE users SET first_name=$2, last_name=$3, username=$4, phone=$5, photo=$6, registered=TRUE WHERE id=$1 RETURNING *`,
      [req.user.id, first, last, username, phone, photo]);
    // A'zo sifatidagi ismni yangilash
    await q(`UPDATE members SET name=$2 WHERE user_id=$1`, [req.user.id, `${first} ${last}`]);
    if (register) await q(`INSERT INTO activity (user_id, icon, title, sub) VALUES ($1,'user','Profil yaratildi',$2)`, [req.user.id, '@' + username]);
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw bad('Bu username band. Boshqasini tanlang.');
    throw e;
  }
}
router.post('/me/register', wrap(async (req, res) => res.json(userOut(await saveProfile(req, true)))));
router.patch('/me', wrap(async (req, res) => res.json(userOut(await saveProfile(req, false)))));
router.patch('/me/notif', wrap(async (req, res) => {
  const patch = {};
  for (const k of Object.keys(NOTIF_DEFAULT)) if (typeof req.body[k] === 'boolean') patch[k] = req.body[k];
  const { rows } = await q(`UPDATE users SET notif = notif || $2::jsonb WHERE id=$1 RETURNING *`, [req.user.id, JSON.stringify(patch)]);
  res.json(userOut(rows[0]));
}));
router.post('/me/delete', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT 1 FROM members m JOIN groups g ON g.id=m.group_id WHERE m.user_id=$1 AND g.status='active' LIMIT 1`, [req.user.id]);
  if (rows[0]) throw bad('Faol guruhingiz bor. Hisobni guruh yakunlangach o‘chirish mumkin.');
  await tx(async c => {
    await c.query(`DELETE FROM groups WHERE creator_id=$1 AND status<>'active'`, [req.user.id]);
    await c.query(
      `UPDATE groups SET status='forming', order_ids=NULL, draft_order=NULL, order_locked=FALSE
       WHERE status IN ('queue','ready') AND id IN (SELECT group_id FROM members WHERE user_id=$1)`, [req.user.id]);
    await c.query(
      `DELETE FROM members WHERE user_id=$1 AND group_id IN (SELECT id FROM groups WHERE status='forming')`, [req.user.id]);
    // Yakunlangan guruhlar tarixi saqlanadi, faqat foydalanuvchi bog'lanishi uziladi
    await c.query(`UPDATE members SET user_id=NULL WHERE user_id=$1`, [req.user.id]);
    await c.query(`DELETE FROM users WHERE id=$1`, [req.user.id]);
  });
  res.json({ ok: true });
}));

/* --- Bosh ekran */
async function unreadCounts(userId) {
  const n = await q(`SELECT count(*)::int AS c FROM notifications WHERE user_id=$1 AND NOT read`, [userId]);
  const m = await q(
    `SELECT count(*)::int AS c FROM messages msg JOIN members m ON m.group_id = msg.group_id
     WHERE m.user_id=$1 AND msg.id > m.last_read_msg AND (msg.member_id IS NULL OR msg.member_id <> m.id)`, [userId]);
  return { notifs: n.rows[0].c, chats: m.rows[0].c };
}
router.get('/summary', wrap(async (req, res) => res.json(await unreadCounts(req.user.id))));

router.get('/home', wrap(async (req, res) => {
  const uid = req.user.id;
  const ids = (await q(`SELECT group_id FROM members WHERE user_id=$1 ORDER BY group_id DESC`, [uid])).rows.map(r => r.group_id);
  const groups = [];
  for (const id of ids) {
    const g = await loadGroup(pool, id);
    if (g) groups.push(toClient(g, req.user));
  }
  const invites = req.user.phone ? (await q(
    `SELECT g.id, g.code, g.name, g.size, g.amount, g.period, u.first_name || ' ' || u.last_name AS creator
     FROM members m JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = g.creator_id
     WHERE m.user_id IS NULL AND m.phone=$1 AND m.status='invited' AND g.status='forming'
       AND NOT EXISTS (SELECT 1 FROM members x WHERE x.group_id=g.id AND x.user_id=$2)`,
    [req.user.phone, uid])).rows : [];
  const paid = (await q(
    `SELECT COALESCE(sum(p.amount),0)::bigint AS s FROM payments p JOIN members m ON m.id = p.member_id
     WHERE m.user_id=$1 AND p.status='paid'`, [uid])).rows[0].s;
  const received = (await q(
    `SELECT COALESCE(sum(g.amount * (g.size - 1)),0)::bigint AS s FROM rounds r
     JOIN members m ON m.id = r.recipient_member_id JOIN groups g ON g.id = r.group_id
     WHERE m.user_id=$1 AND r.status='paid_out'`, [uid])).rows[0].s;
  const act = (await q(`SELECT * FROM activity WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [uid])).rows;
  res.json({
    groups, invites, wallet: { paid, received },
    activity: act.map(a => ({ id: a.id, icon: a.icon, title: a.title, sub: a.sub, amount: a.amount, ts: a.created_at })),
    unread: await unreadCounts(uid),
  });
}));

/* --- Guruhlar */
async function addContacts(c, ctx, g, list, user) {
  const phones = new Set(g.members.map(m => m.phone).filter(Boolean));
  for (const raw of list) {
    if (g.members.length >= g.size) throw bad('Guruhda bo‘sh o‘rin qolmadi');
    const name = validName(raw.name, 'Kontakt ismi');
    const phone = normPhone(raw.phone);
    if (!phone) throw bad(`${name}: telefon raqami noto‘g‘ri`);
    if (phone === user.phone) throw bad('Bu sizning raqamingiz — siz allaqachon ishtirokchisiz');
    if (phones.has(phone)) throw bad(`${name}: bu raqam allaqachon qo‘shilgan`);
    phones.add(phone);
    const { rows: [m] } = await c.query(
      `INSERT INTO members (group_id, name, phone, role, status) VALUES ($1,$2,$3,'member','invited') RETURNING *`,
      [g.id, name, phone]);
    g.members.push(m);
    await sys(c, g.id, `✉️ ${name} guruhga taklif qilindi.`);
    const { rows: [u] } = await c.query(`SELECT id FROM users WHERE phone=$1 AND registered`, [phone]);
    if (u) await notify(c, ctx, u.id, 'invited', `${fullName(user)} sizni “${g.name}” guruhiga taklif qildi`, null);
  }
}

router.post('/groups', wrap(async (req, res) => {
  const b = req.body || {};
  const u = req.user;
  if (!u.registered) throw bad('Avval profilni to‘ldiring');
  const name = validName(b.name, 'Guruh nomi');
  const size = Number(b.size);
  if (!Number.isInteger(size) || size < 4 || size > 12) throw bad('Ishtirokchilar soni 4–12 bo‘lsin');
  const amount = Math.round(Number(b.amount));
  if (!(amount >= 1000 && amount <= 1e10)) throw bad('Badal miqdori kamida 1 000 so‘m bo‘lsin');
  const period = b.period === 'weekly' ? 'weekly' : b.period === 'monthly' ? 'monthly' : null;
  if (!period) throw bad('Davriylikni tanlang');
  const method = ['lottery', 'manual', 'random'].includes(b.queueMethod) ? b.queueMethod : null;
  if (!method) throw bad('Navbat usulini tanlang');
  const start = String(b.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < todayISO()) throw bad('Boshlanish sanasi bugundan oldin bo‘lmasin');
  let image = null;
  if (b.image) { parseDataURL(b.image, 400 * 1024); image = b.image; }
  const contacts = Array.isArray(b.contacts) ? b.contacts : [];
  if (contacts.length > size - 1) throw bad(`Yaratuvchidan tashqari ko‘pi bilan ${size - 1} kishi`);

  const id = await act(async (c, ctx) => {
    const { rows: [g] } = await c.query(
      `INSERT INTO groups (code, name, image, size, amount, period, start_date, queue_method, creator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomCode(), name, image, size, amount, period, start, method, u.id]);
    const { rows: [cm] } = await c.query(
      `INSERT INTO members (group_id, user_id, name, phone, role, status, joined_at)
       VALUES ($1,$2,$3,$4,'creator','joined',now()) RETURNING *`, [g.id, u.id, fullName(u), u.phone]);
    g.members = [cm];
    g.rounds = [];
    await sys(c, g.id, `👋 “${name}” guruhi yaratildi. ${size} kishi · ${money(amount)} · ${PERIOD[period].toLowerCase()}. Har davrda oluvchiga ${money(amount * (size - 1))}.`);
    await addContacts(c, ctx, g, contacts, u);
    await activity(c, u.id, 'users', 'Guruh yaratildi', name);
    await checkFull(c, ctx, g);
    return g.id;
  });
  res.json({ id });
}));

router.get('/groups/:id', wrap(async (req, res) => {
  const g = await groupFor(pool, req.params.id, req.user);
  res.json(toClient(g, req.user));
}));

const groupAction = (opts, fn) => wrap(async (req, res) => {
  const out = await act(async (c, ctx) => {
    const g = await groupFor(c, req.params.id, req.user, { lock: true, owner: !!opts.owner });
    if (opts.status && !opts.status.includes(g.status)) throw bad('Guruhning hozirgi holatida bu amal mumkin emas');
    return fn(c, ctx, g, req);
  });
  if (out && out.deleted) return res.json({ ok: true });
  const g = await loadGroup(pool, Number(req.params.id));
  res.json(toClient(g, req.user));
});

router.post('/groups/:id/contacts', groupAction({ owner: true, status: ['forming'] }, async (c, ctx, g, req) => {
  await addContacts(c, ctx, g, [req.body || {}], req.user);
  await checkFull(c, ctx, g);
}));

router.delete('/groups/:id/members/:mid', groupAction({ owner: true, status: ['forming'] }, async (c, ctx, g, req) => {
  const m = member(g, Number(req.params.mid));
  if (!m) throw notFound('Ishtirokchi topilmadi');
  if (m.role === 'creator') throw bad('Yaratuvchini olib tashlab bo‘lmaydi');
  await c.query('DELETE FROM members WHERE id=$1', [m.id]);
  await sys(c, g.id, `${m.name} guruhdan olib tashlandi.`);
}));

// Telegram'dan foydalanmaydigan ishtirokchi: yaratuvchi uning nomidan "qo'shildi" deb belgilaydi
router.post('/groups/:id/members/:mid/offline', groupAction({ owner: true, status: ['forming'] }, async (c, ctx, g, req) => {
  const m = member(g, Number(req.params.mid));
  if (!m || m.status !== 'invited') throw bad('Bu ishtirokchi taklif holatida emas');
  await c.query(`UPDATE members SET status='joined', offline=TRUE, joined_at=now() WHERE id=$1`, [m.id]);
  m.status = 'joined';
  await sys(c, g.id, `🙌 ${m.name} guruhga qo‘shildi (Telegram’siz, yaratuvchi tasdiqladi).`);
  await checkFull(c, ctx, g);
}));

router.post('/groups/:id/lottery', groupAction({ owner: true, status: ['queue'] }, async (c, ctx, g) => {
  if (g.queue_method !== 'lottery') throw bad('Bu guruhda navbat qur’a bilan aniqlanmaydi');
  const draft = shuffle(g.members.map(m => m.id));
  await c.query('UPDATE groups SET draft_order=$2 WHERE id=$1', [g.id, draft]);
  await sys(c, g.id, '🎲 Qur’a o‘tkazildi. Yaratuvchi natijani tasdiqlashi kutilmoqda.');
}));

router.post('/groups/:id/lock', groupAction({ owner: true, status: ['queue'] }, async (c, ctx, g, req) => {
  if (g.queue_method === 'random') return lockOrder(c, ctx, g, [], 'random');
  if (g.queue_method === 'lottery') {
    if (!g.draft_order || g.draft_order.length !== g.members.length) throw bad('Avval qur’ani o‘tkazing');
    return lockOrder(c, ctx, g, g.draft_order, 'lottery');
  }
  const order = (req.body.order || []).map(Number);
  const ids = g.members.map(m => m.id);
  if (order.length !== ids.length || new Set(order).size !== ids.length || !order.every(id => ids.includes(id))) {
    throw bad('Navbat tartibi noto‘g‘ri');
  }
  return lockOrder(c, ctx, g, order, 'manual');
}));

router.post('/groups/:id/paysettings', groupAction({}, async (c, ctx, g, req) => {
  const method = req.body.method === 'card' ? 'card' : 'cash';
  let cardId = null;
  if (method === 'card') {
    cardId = Number(req.body.cardId);
    const { rows } = await c.query('SELECT id FROM cards WHERE id=$1 AND user_id=$2', [cardId, req.user.id]);
    if (!rows[0]) throw bad('Kartani tanlang');
  }
  const autopay = method === 'card' && !!req.body.autopay;
  await c.query('UPDATE members SET pay_method=$2, card_id=$3, autopay=$4 WHERE id=$1', [g.mine.id, method, cardId, autopay]);
}));

router.post('/groups/:id/start', groupAction({ owner: true, status: ['ready'] }, async (c, ctx, g) => {
  await startGroup(c, ctx, g);
}));

function currentRound(g) {
  const r = g.rounds.find(x => x.idx === g.current_round);
  if (!r || r.status !== 'collecting') throw bad('Hozir to‘lov yig‘ilayotgan davr yo‘q');
  return r;
}

router.post('/groups/:id/pay', groupAction({ status: ['active'] }, async (c, ctx, g, req) => {
  const r = currentRound(g);
  const p = r.payments.find(x => x.member_id === g.mine.id);
  if (!p) throw bad('Bu davrda siz pul oluvchisiz — to‘lov qilmaysiz');
  if (p.status === 'paid') throw bad('To‘lov allaqachon qayd etilgan');
  if (req.body.method === 'card') {
    const { rows } = await c.query('SELECT id FROM cards WHERE id=$1 AND user_id=$2', [Number(req.body.cardId), req.user.id]);
    if (!rows[0]) throw bad('Kartani tanlang');
    await markPaid(c, ctx, g, r, p, 'card', false);
  } else {
    await claimCash(c, ctx, g, r, p);
  }
}));

// Oluvchi yoki yaratuvchi naqd pulni olganini tasdiqlaydi
router.post('/groups/:id/payments/:pid/confirm', groupAction({ status: ['active'] }, async (c, ctx, g, req) => {
  const r = currentRound(g);
  const p = r.payments.find(x => x.id === Number(req.params.pid));
  if (!p) throw notFound('To‘lov topilmadi');
  const rec = member(g, r.recipient_member_id);
  if (rec.user_id !== req.user.id && g.creator_id !== req.user.id) throw forbidden('Faqat oluvchi yoki yaratuvchi tasdiqlaydi');
  if (p.status === 'paid') return;
  await markPaid(c, ctx, g, r, p, 'cash', false);
}));

router.delete('/groups/:id', wrap(async (req, res) => {
  await act(async (c, ctx) => {
    const g = await groupFor(c, req.params.id, req.user, { lock: true });
    if (g.creator_id === req.user.id) {
      // group_id = null: bildirishnoma guruh bilan birga o'chib ketmasin
      for (const m of g.members) {
        if (m.user_id && m.user_id !== req.user.id) await notify(c, ctx, m.user_id, 'completed', `“${g.name}” guruhi yaratuvchi tomonidan o‘chirildi`, null);
      }
      await c.query('DELETE FROM groups WHERE id=$1', [g.id]);
      await activity(c, req.user.id, 'trash', 'Guruh o‘chirildi', g.name);
      return;
    }
    if (g.status === 'active') throw bad('Faol guruhdan chiqib bo‘lmaydi');
    if (g.status === 'completed') {
      await c.query('UPDATE members SET user_id=NULL WHERE id=$1', [g.mine.id]);
      return;
    }
    await c.query('DELETE FROM members WHERE id=$1', [g.mine.id]);
    if (g.status !== 'forming') {
      await c.query(`UPDATE groups SET status='forming', order_ids=NULL, draft_order=NULL, order_locked=FALSE WHERE id=$1`, [g.id]);
    }
    await sys(c, g.id, `🚪 ${g.mine.name} guruhdan chiqdi.`);
    await notify(c, ctx, g.creator_id, 'invited', `“${g.name}”: ${g.mine.name} guruhdan chiqdi`, g.id);
    await activity(c, req.user.id, 'logout', 'Guruhdan chiqildi', g.name);
  });
  res.json({ ok: true });
}));

/* --- Takliflar */
router.get('/invite/:code', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT g.id, g.name, g.size, g.amount, g.period, g.start_date, g.queue_method, g.status, g.image,
       u.first_name || ' ' || u.last_name AS creator,
       (SELECT count(*)::int FROM members m WHERE m.group_id=g.id) AS members,
       EXISTS (SELECT 1 FROM members m WHERE m.group_id=g.id AND m.user_id=$2) AS joined
     FROM groups g JOIN users u ON u.id=g.creator_id WHERE g.code=$1`, [String(req.params.code), req.user.id]);
  if (!rows[0]) throw notFound('Taklif havolasi eskirgan yoki noto‘g‘ri');
  const g = rows[0];
  res.json({
    id: g.id, name: g.name, size: g.size, amount: g.amount, period: g.period, startDate: g.start_date,
    queueMethod: g.queue_method, status: g.status, image: g.image, creator: g.creator, members: g.members, joined: g.joined,
  });
}));

async function joinGroup(c, ctx, g, user) {
  if (g.members.some(m => m.user_id === user.id)) return;
  if (g.status !== 'forming') throw bad('Guruh allaqachon shakllangan');
  let m = user.phone && g.members.find(x => !x.user_id && x.phone === user.phone && x.status === 'invited');
  if (m) {
    await c.query(`UPDATE members SET user_id=$2, name=$3, status='joined', joined_at=now() WHERE id=$1`, [m.id, user.id, fullName(user)]);
    Object.assign(m, { user_id: user.id, name: fullName(user), status: 'joined' });
  } else if (g.members.length < g.size) {
    const { rows: [nm] } = await c.query(
      `INSERT INTO members (group_id, user_id, name, phone, role, status, joined_at) VALUES ($1,$2,$3,$4,'member','joined',now()) RETURNING *`,
      [g.id, user.id, fullName(user), user.phone]);
    g.members.push(nm);
  } else throw bad('Guruhda bo‘sh o‘rin yo‘q. Yaratuvchidan sizni ro‘yxatga qo‘shishini so‘rang.');
  await sys(c, g.id, `🙌 ${fullName(user)} guruhga qo‘shildi.`);
  await notify(c, ctx, g.creator_id, 'invited', `“${g.name}”: ${fullName(user)} guruhga qo‘shildi`, g.id);
  await activity(c, user.id, 'hand', 'Guruhga qo‘shildingiz', g.name);
  await checkFull(c, ctx, g);
}

router.post('/invite/:code/join', wrap(async (req, res) => {
  if (!req.user.registered) throw bad('Avval profilni to‘ldiring');
  const id = await act(async (c, ctx) => {
    const { rows } = await c.query('SELECT id FROM groups WHERE code=$1', [String(req.params.code)]);
    if (!rows[0]) throw notFound('Taklif havolasi eskirgan yoki noto‘g‘ri');
    const g = await loadGroup(c, rows[0].id, true);
    await joinGroup(c, ctx, g, req.user);
    return g.id;
  });
  res.json({ id });
}));

router.post('/groups/:id/decline', wrap(async (req, res) => {
  await act(async (c, ctx) => {
    const g = await loadGroup(c, Number(req.params.id), true);
    if (!g) throw notFound('Guruh topilmadi');
    const m = req.user.phone && g.members.find(x => !x.user_id && x.phone === req.user.phone && x.status === 'invited');
    if (!m) throw notFound('Taklif topilmadi');
    await c.query('DELETE FROM members WHERE id=$1', [m.id]);
    await sys(c, g.id, `${m.name} taklifni rad etdi.`);
    await notify(c, ctx, g.creator_id, 'invited', `“${g.name}”: ${m.name} taklifni rad etdi`, g.id);
  });
  res.json({ ok: true });
}));

/* --- Chat */
function msgOut(m, myMemberId) {
  return {
    id: m.id, type: m.type, text: m.text, kind: m.kind, duration: m.duration,
    media: m.media_id ? `/api/media/${m.media_id}` : null,
    memberId: m.member_id, name: m.name, photo: m.photo, mine: !!myMemberId && m.member_id === myMemberId,
    ts: m.created_at,
  };
}
router.get('/groups/:id/messages', wrap(async (req, res) => {
  const g = await groupFor(pool, req.params.id, req.user);
  const after = Number(req.query.after || 0);
  const sel = `SELECT msg.*, mb.name, u.photo FROM messages msg
    LEFT JOIN members mb ON mb.id = msg.member_id LEFT JOIN users u ON u.id = mb.user_id WHERE msg.group_id=$1`;
  const rows = after
    ? (await q(`${sel} AND msg.id > $2 ORDER BY msg.id LIMIT 200`, [g.id, after])).rows
    : (await q(`${sel} ORDER BY msg.id DESC LIMIT 300`, [g.id])).rows.reverse();
  res.json(rows.map(m => msgOut(m, g.mine.id)));
}));

router.post('/groups/:id/messages', wrap(async (req, res) => {
  const g = await groupFor(pool, req.params.id, req.user);
  const b = req.body || {};
  const type = ['text', 'image', 'video', 'voice'].includes(b.type) ? b.type : null;
  if (!type) throw bad('Xabar turi noto‘g‘ri');
  let text = null, mediaId = null;
  if (type === 'text') {
    text = String(b.text || '').trim().slice(0, 2000);
    if (!text) throw bad('Xabar bo‘sh');
  } else {
    const { mime, buf } = parseDataURL(b.media, MEDIA_LIMIT[type]);
    const okMime = type === 'image' ? /^image\// : type === 'video' ? /^video\// : /^audio\/|^video\/webm/;
    if (!okMime.test(mime)) throw bad('Fayl turi mos emas');
    mediaId = randomId();
    await q('INSERT INTO media (id, mime, data) VALUES ($1,$2,$3)', [mediaId, mime, buf]);
  }
  const duration = type === 'voice' && b.duration ? String(b.duration).slice(0, 8) : null;
  const { rows: [m] } = await q(
    `INSERT INTO messages (group_id, member_id, type, text, media_id, duration) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [g.id, g.mine.id, type, text, mediaId, duration]);
  await q('UPDATE members SET last_read_msg=$2 WHERE id=$1', [g.mine.id, m.id]);
  res.json(msgOut({ ...m, name: g.mine.name, photo: req.user.photo }, g.mine.id));
}));

router.post('/groups/:id/read', wrap(async (req, res) => {
  const g = await groupFor(pool, req.params.id, req.user);
  await q('UPDATE members SET last_read_msg=GREATEST(last_read_msg, $2) WHERE id=$1', [g.mine.id, Number(req.body.lastId || 0)]);
  res.json({ ok: true });
}));

router.get('/chats', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT g.id, g.name, g.image, g.size, g.status, g.current_round,
       lm.id AS last_id, lm.type AS last_type, lm.text AS last_text, lm.created_at AS last_ts, lmb.name AS last_name,
       (lm.member_id = m.id) AS last_mine,
       (SELECT count(*)::int FROM messages x WHERE x.group_id=g.id AND x.id > m.last_read_msg
          AND (x.member_id IS NULL OR x.member_id <> m.id)) AS unread,
       (SELECT count(*)::int FROM members y WHERE y.group_id=g.id) AS members
     FROM members m JOIN groups g ON g.id = m.group_id
     LEFT JOIN LATERAL (SELECT * FROM messages z WHERE z.group_id=g.id ORDER BY z.id DESC LIMIT 1) lm ON TRUE
     LEFT JOIN members lmb ON lmb.id = lm.member_id
     WHERE m.user_id=$1
     ORDER BY COALESCE(lm.created_at, g.created_at) DESC`, [req.user.id]);
  res.json(rows.map(r => ({
    id: r.id, name: r.name, image: r.image, status: r.status, members: r.members, unread: r.unread,
    last: r.last_id ? { type: r.last_type, text: r.last_text, ts: r.last_ts, name: r.last_name, mine: r.last_mine } : null,
  })));
}));

/* --- Kartalar (demo: karta raqami to'liq saqlanmaydi, faqat birinchi va oxirgi 4 raqam) */
const pendingCards = new Map(); // userId -> { data, code, expires, tries }
const cardOut = c => ({ id: c.id, type: c.type, first4: c.first4, last4: c.last4, holder: c.holder, exp: c.exp, primary: c.is_primary });
const brandOf = n => (/^(8600|5614)/.test(n) ? 'uzcard' : /^9860/.test(n) ? 'humo' : /^4/.test(n) ? 'visa' : null);

router.get('/cards', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM cards WHERE user_id=$1 ORDER BY id', [req.user.id]);
  res.json(rows.map(cardOut));
}));
router.post('/cards/otp', wrap(async (req, res) => {
  const b = req.body || {};
  const n = String(b.number || '').replace(/\D/g, '');
  if (n.length !== 16) throw bad('Karta raqami 16 ta raqamdan iborat bo‘lsin');
  const type = brandOf(n) || (['uzcard', 'humo', 'visa'].includes(b.type) ? b.type : null);
  if (!type) throw bad('Karta turini tanlang');
  const m = /^(\d{2})\/(\d{2})$/.exec(String(b.exp || ''));
  if (!m || +m[1] < 1 || +m[1] > 12) throw bad('Amal qilish muddatini OO/YY ko‘rinishida kiriting');
  const now = new Date(), ey = 2000 + +m[2], em = +m[1];
  if (ey < now.getFullYear() || (ey === now.getFullYear() && em < now.getMonth() + 1)) throw bad('Kartaning muddati tugagan');
  const holder = String(b.holder || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (holder.length < 3 || !holder.includes(' ')) throw bad('Karta egasining ism va familiyasini kiriting');
  const code = String(100000 + Math.floor(Math.random() * 900000));
  pendingCards.set(req.user.id, { data: { type, first4: n.slice(0, 4), last4: n.slice(-4), holder, exp: b.exp }, code, expires: Date.now() + 5 * 60e3, tries: 0 });
  // [BACKEND/BANK] Haqiqiy tizimda kod bank (ekvayring provayderi) tomonidan SMS orqali yuboriladi
  const sent = await tg('sendMessage', { chat_id: req.user.tg_id, text: `Kassachi: karta tasdiqlash kodi — ${code}\n${type.toUpperCase()} •• ${n.slice(-4)} (demo, 5 daqiqa amal qiladi)` });
  const masked = holder.split(' ').map((w, i) => (i === 0 ? w : w[0] + '*'.repeat(Math.max(2, w.length - 1)))).join(' ');
  res.json({ sent: !!sent.ok, type, holderMasked: masked, last4: n.slice(-4) });
}));
router.post('/cards/confirm', wrap(async (req, res) => {
  const p = pendingCards.get(req.user.id);
  if (!p || p.expires < Date.now()) throw bad('Kod eskirgan. Qaytadan urinib ko‘ring.');
  if (String(req.body.code || '') !== p.code) {
    if (++p.tries >= 5) pendingCards.delete(req.user.id);
    throw bad('Kod noto‘g‘ri');
  }
  pendingCards.delete(req.user.id);
  const d = p.data;
  const card = await tx(async c => {
    const dup = await c.query('SELECT 1 FROM cards WHERE user_id=$1 AND first4=$2 AND last4=$3 AND type=$4', [req.user.id, d.first4, d.last4, d.type]);
    if (dup.rows[0]) throw bad('Bu karta allaqachon qo‘shilgan');
    const cnt = (await c.query('SELECT count(*)::int AS n FROM cards WHERE user_id=$1', [req.user.id])).rows[0].n;
    const { rows: [row] } = await c.query(
      `INSERT INTO cards (user_id, type, first4, last4, holder, exp, is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, d.type, d.first4, d.last4, d.holder, d.exp, cnt === 0]);
    await activity(c, req.user.id, 'card', 'Karta qo‘shildi', `${d.type.toUpperCase()} •• ${d.last4}`);
    return row;
  });
  res.json(cardOut(card));
}));
router.post('/cards/:id/primary', wrap(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('SELECT id FROM cards WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id]);
    if (!rows[0]) throw notFound('Karta topilmadi');
    await c.query('UPDATE cards SET is_primary = (id=$2) WHERE user_id=$1', [req.user.id, Number(req.params.id)]);
  });
  res.json({ ok: true });
}));
router.delete('/cards/:id', wrap(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('DELETE FROM cards WHERE id=$1 AND user_id=$2 RETURNING is_primary', [Number(req.params.id), req.user.id]);
    if (!rows[0]) throw notFound('Karta topilmadi');
    await c.query(`UPDATE members SET autopay=FALSE, pay_method='cash' WHERE user_id=$1 AND card_id IS NULL AND pay_method='card'`, [req.user.id]);
    if (rows[0].is_primary) {
      await c.query(`UPDATE cards SET is_primary=TRUE WHERE id=(SELECT id FROM cards WHERE user_id=$1 ORDER BY id LIMIT 1)`, [req.user.id]);
    }
  });
  res.json({ ok: true });
}));

/* --- Bildirishnomalar */
router.get('/notifications', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json(rows.map(n => ({ id: n.id, type: n.type, text: n.text, gid: n.group_id, read: n.read, ts: n.created_at })));
}));
router.post('/notifications/read', wrap(async (req, res) => {
  await q('UPDATE notifications SET read=TRUE WHERE user_id=$1 AND NOT read', [req.user.id]);
  res.json({ ok: true });
}));
router.delete('/notifications', wrap(async (req, res) => {
  await q('DELETE FROM notifications WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));
