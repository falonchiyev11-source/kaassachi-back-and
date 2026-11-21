import crypto from 'node:crypto';
import { q } from './db.js';
import { money, PERIOD, normPhone } from './util.js';

const TOKEN = process.env.BOT_TOKEN;
export let BOT_USERNAME = process.env.BOT_USERNAME || null;

export async function tg(method, body = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.warn(`[tg] ${method}: ${j.description}`);
    return j;
  } catch (e) {
    console.warn(`[tg] ${method} xato: ${e.message}`);
    return { ok: false };
  }
}

export const webappUrl = (params = '') =>
  (process.env.WEBAPP_URL || '').replace(/\/$/, '') + '/' + (params ? `?${params}` : '');

// Webhook so'rovlari haqiqatan Telegram'dan kelayotganini tekshirish uchun maxfiy kalit
export const webhookSecret = () =>
  crypto.createHash('sha256').update('kassachi-webhook:' + TOKEN).digest('hex').slice(0, 48);

export const inviteLink = code => (BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=join_${code}` : null);

const openKb = (text, params) => ({ inline_keyboard: [[{ text, web_app: { url: webappUrl(params) } }]] });

export function sendToUser(tgId, text, params = '') {
  if (!process.env.WEBAPP_URL) return tg('sendMessage', { chat_id: tgId, text });
  return tg('sendMessage', { chat_id: tgId, text, reply_markup: openKb('Kassachi’ni ochish', params) });
}

export async function setupBot(publicUrl) {
  if (!TOKEN) { console.warn('BOT_TOKEN yo‘q — bot o‘chirilgan'); return; }
  const me = await tg('getMe');
  if (me.ok) BOT_USERNAME = me.result.username;
  if (publicUrl) {
    await tg('setWebhook', {
      url: `${publicUrl.replace(/\/$/, '')}/bot/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ['message'],
    });
  } else console.warn('PUBLIC_URL / RENDER_EXTERNAL_URL yo‘q — webhook o‘rnatilmadi');
  if (process.env.WEBAPP_URL) {
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Kassachi', web_app: { url: webappUrl() } } });
  }
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Kassachi’ni ochish' },
      { command: 'help', description: 'Kassachi qanday ishlaydi' },
    ],
  });
  console.log(`Bot tayyor: @${BOT_USERNAME}`);
}

const WELCOME =
  'Assalomu alaykum! Kassachi — 4–12 kishilik guruhda navbat bilan pul aylantirish xizmati.\n\n' +
  '• Guruh yarating, badal va davriylikni belgilang\n' +
  '• Ishtirokchilarni havola yoki QR-kod orqali taklif qiling\n' +
  '• Qur’a yoki qo‘lda navbatni aniqlang\n' +
  '• Har davrda yig‘ilgan pul navbatdagi ishtirokchiga beriladi\n\n' +
  'Boshlash uchun pastdagi tugmani bosing.';

const HELP =
  'Qanday ishlaydi:\n' +
  '1. Guruh a’zolari har davrda kelishilgan badalni to‘laydi.\n' +
  '2. Shu davrning oluvchisi o‘ziga to‘lamaydi — u qolganlarning badalini oladi.\n' +
  '3. Navbat hamma pul olguncha davom etadi.\n\n' +
  'Muhim: bank integratsiyasi hali ulanmagan. To‘lovlar naqd qayd etiladi yoki karta orqali simulyatsiya qilinadi — ilova haqiqiy pul o‘tkazmaydi.';

export async function handleUpdate(update) {
  const m = update.message;
  if (!m || !m.from || m.chat.type !== 'private') return;
  const chat = m.chat.id;

  if (m.contact) {
    if (m.contact.user_id !== m.from.id) {
      return tg('sendMessage', { chat_id: chat, text: 'Faqat o‘zingizning raqamingizni ulashing.' });
    }
    const phone = normPhone(m.contact.phone_number);
    if (!phone) return tg('sendMessage', { chat_id: chat, text: 'Hozircha faqat +998 raqamlari qo‘llab-quvvatlanadi.' });
    await q('UPDATE users SET phone=$2 WHERE tg_id=$1', [m.from.id, phone]);
    return tg('sendMessage', {
      chat_id: chat,
      text: 'Telefon raqamingiz saqlandi ✅',
      reply_markup: process.env.WEBAPP_URL ? openKb('Kassachi’ni ochish') : undefined,
    });
  }

  const text = (m.text || '').trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    if (payload.startsWith('join_')) {
      const code = payload.slice(5).replace(/[^a-z0-9]/gi, '');
      const { rows } = await q(
        `SELECT g.name, g.size, g.amount, g.period, u.first_name
         FROM groups g JOIN users u ON u.id = g.creator_id WHERE g.code=$1`, [code]);
      const g = rows[0];
      if (!g) return tg('sendMessage', { chat_id: chat, text: 'Taklif havolasi eskirgan yoki noto‘g‘ri.' });
      return tg('sendMessage', {
        chat_id: chat,
        text: `${g.first_name} sizni “${g.name}” guruhiga taklif qildi.\n${g.size} kishi · ${money(g.amount)} · ${PERIOD[g.period].toLowerCase()}\n\nQo‘shilish uchun tugmani bosing.`,
        reply_markup: openKb('Taklifni ko‘rish', `join=${code}`),
      });
    }
    return tg('sendMessage', { chat_id: chat, text: WELCOME, reply_markup: process.env.WEBAPP_URL ? openKb('Kassachi’ni ochish') : undefined });
  }
  if (text.startsWith('/help')) return tg('sendMessage', { chat_id: chat, text: HELP });
  return tg('sendMessage', {
    chat_id: chat,
    text: 'Kassachi ilovasini ochish uchun tugmani bosing.',
    reply_markup: process.env.WEBAPP_URL ? openKb('Kassachi’ni ochish') : undefined,
  });
}
