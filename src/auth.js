import crypto from 'node:crypto';
import { q } from './db.js';

const MAX_AGE = 7 * 24 * 3600; // initData 7 kungacha amal qiladi

// Telegram Mini App initData imzosini tekshirish
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return { user, startParam: params.get('start_param') || null };
  } catch {
    return null;
  }
}

export function authMiddleware(botToken) {
  return async (req, res, next) => {
    try {
      let tgUser = null;
      const h = req.get('authorization') || '';
      if (h.startsWith('tma ')) {
        const v = verifyInitData(h.slice(4), botToken);
        if (v) tgUser = v.user;
      }
      if (!tgUser && process.env.DEV_AUTH === '1' && req.get('x-dev-user')) {
        const id = Number(req.get('x-dev-user'));
        tgUser = { id, first_name: 'Dev' + id };
      }
      if (!tgUser) return res.status(401).json({ error: 'Telegram orqali kiring' });

      const { rows } = await q(
        `INSERT INTO users (tg_id, first_name, last_name, tg_username, photo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tg_id) DO UPDATE SET tg_username = EXCLUDED.tg_username,
           photo = COALESCE(users.photo, EXCLUDED.photo)
         RETURNING *`,
        [tgUser.id, tgUser.first_name || '', tgUser.last_name || '', tgUser.username || null, tgUser.photo_url || null]
      );
      req.user = rows[0];
      next();
    } catch (e) {
      next(e);
    }
  };
}
