# GLOW NEXUS — Telegram Mini App Shop

## Đã có

- Mini App `/app.html` (avatar, số dư, shop, nạp QR, lịch sử, báo lỗi)
- API + verify initData Telegram
- Bot chat + nút mở Mini App
- Kho key server, chống double mua
- Webhook nạp tiền shopglow + đúng số tiền
- Thông báo admin

## Cài

```bash
cd tele-shop
cp .env.example .env
# Điền BOT_TOKEN, ADMIN_IDS, WEBHOOK_SECRET, PUBLIC_URL
npm install
npm start
```

Local: `ALLOW_DEV_AUTH=1` rồi mở http://localhost:3000/app.html

## BotFather

Menu Button URL: `https://YOUR_DOMAIN/app.html`  
PUBLIC_URL trong .env phải trùng domain HTTPS.

## Webhook

POST https://YOUR_DOMAIN/webhook/payment  
Header: x-webhook-secret: WEBHOOK_SECRET

## Admin bot

ADDKEY | p1 | key-content  
CONG | telegramUserId | 50000

## Checklist

1. Host HTTPS
2. Điền .env
3. npm start
4. Gắn Menu Button BotFather
5. Test trong Telegram
6. Gắn webhook ngân hàng
