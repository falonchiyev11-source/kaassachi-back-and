import crypto from 'node:crypto';

export const PERIOD = { weekly: 'Haftalik', monthly: 'Oylik' };
export const METHOD = { lottery: 'Qur’a', manual: 'Qo‘lda', random: 'Tasodifiy tanlash' };
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

export const num = n => String(Math.abs(Math.round(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const money = n => (n < 0 ? '−' : '') + num(n) + ' so‘m';

const pad2 = n => String(n).padStart(2, '0');
export const isoOf = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
// O'zbekiston vaqti (UTC+5) bo'yicha bugungi sana
export const todayISO = () => isoOf(new Date(Date.now() + 5 * 3600e3));
const parseISO = s => new Date(s + 'T00:00:00Z');
export const fmtDate = s => { const d = parseISO(s); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const fmtShort = s => { const d = parseISO(s); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}`; };

export function addPeriod(iso, period, n) {
  const d = parseISO(iso);
  if (period === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return isoOf(d);
}
export const daysUntil = iso => Math.round((parseISO(iso) - parseISO(todayISO())) / 864e5);

export function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const randomCode = (len = 10) => {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
};
export const randomId = () => crypto.randomBytes(16).toString('hex');

// Telefon: faqat raqamlar, "998XXXXXXXXX" ko'rinishida
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 9) d = '998' + d;
  return /^998\d{9}$/.test(d) ? d : null;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = msg => new HttpError(400, msg);
export const forbidden = (msg = 'Bu amal uchun ruxsat yo‘q') => new HttpError(403, msg);
export const notFound = (msg = 'Topilmadi') => new HttpError(404, msg);

export function parseDataURL(url, maxBytes) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(url || ''));
  if (!m) throw bad('Fayl formati noto‘g‘ri');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw bad(`Fayl hajmi ${Math.round(maxBytes / 1048576)} MB dan oshmasin`);
  return { mime: m[1], buf };
}
