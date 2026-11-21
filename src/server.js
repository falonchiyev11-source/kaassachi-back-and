import express from 'express';
import cors from 'cors';
import { migrate } from './db.js';
import { authMiddleware } from './auth.js';
import { router, publicRouter } from './routes.js';
import { setupBot, handleUpdate, webhookSecret } from './bot.js';
import { startScheduler } from './engine.js';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN topilmadi. Render > Environment bo‘limida kiriting.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const origins = (process.env.WEBAPP_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

app.get('/', (req, res) => res.json({ ok: true, service: 'kassachi-api' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// Telegram webhook
app.post('/bot/webhook', express.json({ limit: '1mb' }), (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret()) return res.sendStatus(401);
  res.sendStatus(200);
  handleUpdate(req.body).catch(e => console.error('[bot]', e));
});

app.use('/api', publicRouter);
app.use('/api', express.json({ limit: '25mb' }), authMiddleware(TOKEN), router);

app.use((req, res) => res.status(404).json({ error: 'Topilmadi' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Fayl juda katta' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Serverda xatolik yuz berdi. Birozdan keyin qayta urinib ko‘ring.' : err.message });
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

(async () => {
  await migrate();
  console.log('Ma’lumotlar bazasi tayyor');
  app.listen(PORT, () => console.log(`Kassachi API: ${PORT}-port`));
  await setupBot(PUBLIC_URL);
  startScheduler();
})().catch(e => {
  console.error('Ishga tushmadi:', e);
  process.exit(1);
});
