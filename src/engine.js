/* Navbat va pul aylanish dvigateli
   Qoida: har davrda bitta ishtirokchi (oluvchi) qolgan N−1 ishtirokchining badalini oladi.
   Oluvchi o'sha davrda o'ziga to'lamaydi. Oluvchiga jami = badal × (N−1).
   Bank integratsiyasi yo'q: to'lov naqd qayd etiladi yoki karta orqali SIMULYATSIYA qilinadi. */
import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { money, fmtDate, fmtShort, addPeriod, daysUntil, METHOD } from './util.js';
import { sendToUser, inviteLink } from './bot.js';

export const newCtx = () => ({ out: [] });
export async function flush(ctx) {
  for (const o of ctx.out) await sendToUser(o.tgId, o.text, o.params);
}

export const member = (g, id) => g.members.find(m => m.id === id);
export const pot = g => g.amount * (g.size - 1);

export async function sys(c, gid, text, kind = null) {
  await c.query(`INSERT INTO messages (group_id, type, text, kind) VALUES ($1, 'system', $2, $3)`, [gid, text, kind]);
}
export async function activity(c, userId, icon, title, sub, amount = null) {
  if (!userId) return;
  await c.query(`INSERT INTO activity (user_id, icon, title, sub, amount) VALUES ($1,$2,$3,$4,$5)`, [userId, icon, title, sub, amount]);
}
export async function notify(c, ctx, userId, type, text, gid = null) {
  if (!userId) return;
  const { rows } = await c.query('SELECT tg_id, notif FROM users WHERE id=$1', [userId]);
  const u = rows[0];
  if (!u || (u.notif && u.notif[type] === false)) return;
  await c.query(`INSERT INTO notifications (user_id, type, text, group_id) VALUES ($1,$2,$3,$4)`, [userId, type, text, gid]);
  ctx.out.push({ tgId: u.tg_id, text, params: gid ? `g=${gid}` : '' });
}
export async function notifyGroup(c, ctx, g, type, text, exceptUserId = null) {
  for (const m of g.members) {
    if (m.user_id && m.status === 'joined' && m.user_id !== exceptUserId) await notify(c, ctx, m.user_id, type, text, g.id);
  }
}

export async function loadGroup(c, gid, lock = false) {
  const { rows } = await c.query(`SELECT * FROM groups WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [gid]);
  const g = rows[0];
  if (!g) return null;
  g.members = (await c.query(
    `SELECT m.*, u.photo AS user_photo, u.tg_id
     FROM members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.group_id=$1 ORDER BY m.id`, [gid])).rows;
  g.rounds = (await c.query(`SELECT * FROM rounds WHERE group_id=$1 ORDER BY idx`, [gid])).rows;
  const pays = (await c.query(
    `SELECT p.* FROM payments p JOIN rounds r ON r.id = p.round_id WHERE r.group_id=$1 ORDER BY p.id`, [gid])).rows;
  for (const r of g.rounds) r.payments = pays.filter(p => p.round_id === r.id);
  return g;
}

export async function checkFull(c, ctx, g) {
  if (g.status !== 'forming') return;
  if (g.members.length === g.size && g.members.every(m => m.status === 'joined')) {
    await c.query(`UPDATE groups SET status='queue' WHERE id=$1`, [g.id]);
    g.status = 'queue';
    await sys(c, g.id, `✅ Guruh to‘liq shakllandi: ${g.size} ishtirokchi. Endi navbat belgilanadi (${METHOD[g.queue_method]}).`, 'hl');
    await notifyGroup(c, ctx, g, 'full', `“${g.name}” guruhi to‘liq shakllandi`);
  }
}

export async function lockOrder(c, ctx, g, order, how) {
  if (how === 'random') {
    await c.query(`UPDATE groups SET order_ids='{}', order_locked=TRUE, status='ready', draft_order=NULL WHERE id=$1`, [g.id]);
    await sys(c, g.id, '🎯 Navbat usuli tasdiqlandi: har davr boshida tizim pul oluvchini hali pul olmaganlar orasidan tasodifiy aniqlaydi.', 'hl');
    await notifyGroup(c, ctx, g, 'queue', `“${g.name}”: navbat har davrda tasodifiy aniqlanadi`);
    return;
  }
  await c.query(`UPDATE groups SET order_ids=$2, order_locked=TRUE, status='ready', draft_order=NULL WHERE id=$1`, [g.id, order]);
  if (how === 'lottery') {
    await sys(c, g.id, '🎲 Qur’a yakunlandi. Natija tasdiqlandi va endi o‘zgarmaydi.', 'hl');
    await notifyGroup(c, ctx, g, 'lottery', `“${g.name}”: qur’a yakunlandi`);
  }
  const list = order.map((id, i) => `${i + 1}. ${member(g, id).name} — ${fmtShort(addPeriod(g.start_date, g.period, i))}`).join('\n');
  await sys(c, g.id, '📋 Navbat belgilandi:\n' + list);
  for (const m of g.members) {
    if (m.user_id) await notify(c, ctx, m.user_id, 'queue', `“${g.name}”: navbat belgilandi. Siz ${order.indexOf(m.id) + 1}-navbatdasiz`, g.id);
  }
}

export async function startGroup(c, ctx, g) {
  await c.query(`UPDATE groups SET status='active', started_at=now() WHERE id=$1`, [g.id]);
  g.status = 'active';
  await sys(c, g.id, `🚀 Guruh boshlandi. ${g.size} davr, har davrda oluvchiga ${money(pot(g))}.`);
  for (const m of g.members) if (m.user_id) await activity(c, m.user_id, 'play', 'Guruh boshlandi', g.name);
  await startRound(c, ctx, g, 0);
}

export async function startRound(c, ctx, g, idx) {
  let rid;
  if (g.queue_method === 'random') {
    const got = new Set(g.rounds.map(r => r.recipient_member_id));
    const poolM = g.members.filter(m => !got.has(m.id));
    rid = poolM[crypto.randomInt(poolM.length)].id;
    g.order_ids = [...(g.order_ids || []), rid];
    await c.query('UPDATE groups SET order_ids=$2 WHERE id=$1', [g.id, g.order_ids]);
    await sys(c, g.id, `🎯 Tasodifiy tanlov: ${idx + 1}-davr oluvchisi — ${member(g, rid).name}.`);
  } else {
    rid = g.order_ids[idx];
  }
  const due = addPeriod(g.start_date, g.period, idx);
  const { rows: [r] } = await c.query(
    `INSERT INTO rounds (group_id, idx, recipient_member_id, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
    [g.id, idx, rid, due]);
  r.payments = [];
  for (const m of g.members) {
    if (m.id === rid) continue;
    const { rows: [p] } = await c.query(
      `INSERT INTO payments (round_id, member_id, amount) VALUES ($1,$2,$3) RETURNING *`, [r.id, m.id, g.amount]);
    r.payments.push(p);
  }
  g.rounds.push(r);
  g.current_round = idx;
  await c.query('UPDATE groups SET current_round=$2 WHERE id=$1', [g.id, idx]);

  const rec = member(g, rid);
  await sys(c, g.id,
    `🎉 Ushbu davrda pul olish navbati ${rec.name}ga tegishli. To‘lovlarni belgilangan muddatda amalga oshiring.\nMuddat: ${fmtDate(due)} · har bir to‘lovchi: ${money(g.amount)}`, 'hl');
  if (idx > 0) {
    await sys(c, g.id, `🔄 Navbat almashdi: ${idx + 1}-davr boshlandi.`);
    await notifyGroup(c, ctx, g, 'turn', `“${g.name}”: navbat almashdi — ${idx + 1}-davrda ${rec.name} pul oladi`);
  }
  for (const p of r.payments) {
    const m = member(g, p.member_id);
    if (m.user_id) await notify(c, ctx, m.user_id, 'due', `“${g.name}”: ${money(g.amount)} to‘lov, muddat — ${fmtDate(due)}. Oluvchi: ${rec.name}`, g.id);
  }
  await runAutopay(c, ctx, g, r);
}

// Avto-to'lov muddat kuni (yoki undan keyin) ishga tushadi — shunda davrlar birdaniga "yugurib" ketmaydi
export async function runAutopay(c, ctx, g, r) {
  if (r.status !== 'collecting' || daysUntil(r.due_date) > 0) return;
  for (const p of r.payments) {
    if (r.status !== 'collecting') break;
    if (p.status === 'paid') continue;
    const m = member(g, p.member_id);
    if (m.autopay && m.pay_method === 'card' && m.card_id) await markPaid(c, ctx, g, r, p, 'card', true);
  }
}

const howText = (method, auto) =>
  method === 'card' ? (auto ? 'avto-to‘lov, karta (simulyatsiya)' : 'karta (simulyatsiya)') : 'naqd';

export async function claimCash(c, ctx, g, r, p) {
  if (p.status !== 'pending') return;
  await c.query(`UPDATE payments SET status='claimed', method='cash', claimed_at=now() WHERE id=$1`, [p.id]);
  p.status = 'claimed';
  const m = member(g, p.member_id), rec = member(g, r.recipient_member_id);
  await sys(c, g.id, `🤝 ${m.name} ${rec.name}ga ${money(p.amount)} naqd topshirganini bildirdi. ${rec.name} tasdiqlashi kerak.`);
  const text = `“${g.name}”: ${m.name} ${money(p.amount)} naqd topshirganini bildirdi. Ilovada tasdiqlang.`;
  if (rec.user_id) await notify(c, ctx, rec.user_id, 'paid', text, g.id);
  if (g.creator_id !== rec.user_id) await notify(c, ctx, g.creator_id, 'paid', text, g.id);
}

export async function markPaid(c, ctx, g, r, p, method, auto = false) {
  if (p.status === 'paid') return;
  await c.query(`UPDATE payments SET status='paid', method=$2, paid_at=now() WHERE id=$1`, [p.id, method]);
  p.status = 'paid';
  p.method = method;
  const m = member(g, p.member_id), rec = member(g, r.recipient_member_id);
  const how = howText(method, auto);
  await sys(c, g.id, `✅ ${m.name} ${money(p.amount)} to‘ladi → ${rec.name} · ${how}`, 'money');
  if (m.user_id) {
    await activity(c, m.user_id, 'arrowup', `${g.name}: badal to‘landi`, `${r.idx + 1}-davr · ${rec.name}ga · ${how}`, -p.amount);
    await notify(c, ctx, m.user_id, 'paid', `“${g.name}”: ${money(p.amount)} to‘lovingiz qayd etildi (${how})`, g.id);
  }
  if (r.payments.every(x => x.status === 'paid')) await payout(c, ctx, g, r);
}

async function payout(c, ctx, g, r) {
  await c.query(`UPDATE rounds SET status='paid_out', paid_out_at=now() WHERE id=$1`, [r.id]);
  r.status = 'paid_out';
  const rec = member(g, r.recipient_member_id);
  const total = pot(g);
  await sys(c, g.id, `💸 ${r.idx + 1}-davr yakunlandi: ${rec.name} jami ${money(total)} oldi.`, 'money');
  if (rec.user_id) {
    await activity(c, rec.user_id, 'arrowdown', `${g.name}: pul qabul qilindi`, `${r.idx + 1}-davr`, total);
    await notify(c, ctx, rec.user_id, 'received', `“${g.name}”: ${r.idx + 1}-davr bo‘yicha jami ${money(total)} sizga yetkazildi`, g.id);
  }
  if (r.idx + 1 < g.size) {
    await startRound(c, ctx, g, r.idx + 1);
  } else {
    await c.query(`UPDATE groups SET status='completed', completed_at=now() WHERE id=$1`, [g.id]);
    g.status = 'completed';
    await sys(c, g.id, `🏁 Guruh yakunlandi. ${g.size} ishtirokchining har biri o‘z navbatida ${money(total)} oldi.`, 'hl');
    await notifyGroup(c, ctx, g, 'completed', `“${g.name}” guruhi yakunlandi`);
    for (const m of g.members) if (m.user_id) await activity(c, m.user_id, 'flag', 'Guruh yakunlandi', g.name);
  }
}

// API uchun guruh ko'rinishi
export function toClient(g, user) {
  const mine = g.members.find(m => m.user_id === user.id);
  const isOwner = g.creator_id === user.id;
  return {
    id: g.id,
    name: g.name,
    image: g.image,
    size: g.size,
    amount: g.amount,
    period: g.period,
    startDate: g.start_date,
    queueMethod: g.queue_method,
    status: g.status,
    order: g.order_ids || [],
    draftOrder: isOwner ? g.draft_order || null : null,
    orderLocked: g.order_locked,
    currentRound: g.current_round,
    isOwner,
    me: mine ? mine.id : null,
    code: g.code,
    inviteLink: inviteLink(g.code),
    myPay: mine ? { method: mine.pay_method, autopay: mine.autopay, cardId: mine.card_id } : null,
    members: g.members.map(m => ({
      id: m.id, userId: m.user_id, name: m.name, phone: m.phone, role: m.role,
      status: m.status, offline: m.offline, photo: m.user_photo || null,
    })),
    rounds: g.rounds.map(r => ({
      id: r.id, index: r.idx, recipientId: r.recipient_member_id, dueDate: r.due_date, status: r.status,
      payments: Object.fromEntries(r.payments.map(p => [p.member_id, { id: p.id, status: p.status, method: p.method }])),
    })),
  };
}

// Har 30 daqiqada: muddati kelgan avto-to'lovlar va eslatmalar
export function startScheduler() {
  const run = async () => {
    try {
      const { rows } = await q(
        `SELECT r.id, r.group_id FROM rounds r JOIN groups g ON g.id = r.group_id
         WHERE g.status='active' AND r.status='collecting'`);
      for (const row of rows) {
        const ctx = newCtx();
        await tx(async c => {
          const g = await loadGroup(c, row.group_id, true);
          const r = g && g.rounds.find(x => x.id === row.id);
          if (!r || r.status !== 'collecting') return;
          await runAutopay(c, ctx, g, r);
          if (r.status === 'collecting' && !r.reminded && daysUntil(r.due_date) <= 2) {
            for (const p of r.payments) {
              const m = member(g, p.member_id);
              if (p.status !== 'paid' && m.user_id) {
                await notify(c, ctx, m.user_id, 'due', `⏰ “${g.name}”: to‘lov muddati yaqinlashdi — ${fmtDate(r.due_date)}, ${money(p.amount)}`, g.id);
              }
            }
            await c.query('UPDATE rounds SET reminded=TRUE WHERE id=$1', [r.id]);
          }
        });
        await flush(ctx);
      }
    } catch (e) {
      console.error('[scheduler]', e);
    }
  };
  setTimeout(run, 15000);
  setInterval(run, 30 * 60 * 1000);
}
