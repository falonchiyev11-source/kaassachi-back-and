# Kassachi — backend

Kassachi Telegram Mini App uchun API va Telegram bot: Node.js + Express, ma'lumotlar bazasi Neon (PostgreSQL), joylashuv Render.
Frontend alohida repozitoriyada: https://github.com/falonchiyev11-source/kassachi

## Render'da ishga tushirish

1. render.com → **New → Web Service** → shu repozitoriya.
2. **Build:** `npm install` · **Start:** `npm start` (Root Directory bo'sh qoladi).
3. **Environment** bo'limi:
   - `BOT_TOKEN`: @BotFather bergan token
   - `DATABASE_URL`: Neon connection string
   - `WEBAPP_URL`: Vercel'dagi frontend manzili, masalan `https://kassachi.vercel.app`
4. Deploy. Server birinchi ishga tushganda jadvallarni o'zi yaratadi, bot webhook'ini o'rnatadi va bot menyusiga "Kassachi" tugmasini qo'shadi.
5. Tekshirish: `https://<render-manzil>/health` → `{"ok":true}`

Bot token va parollarni bu repozitoriyaga yozmang — ular faqat Render Environment'da turadi. Namuna uchun: `.env.example`.

## Tuzilma

- `src/server.js`: Express, webhook, ishga tushirish
- `src/auth.js`: Telegram `initData` imzosini tekshirish
- `src/routes.js`: API yo'llari
- `src/engine.js`: navbat va pul aylanish dvigateli, eslatmalar
- `src/bot.js`: Telegram bot
- `src/db.js`: Neon ulanishi va sxema
