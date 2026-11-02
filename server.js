/**
 * GLOW NEXUS — Telegram Mini App Shop (full)
 * Bot chat + WebApp + API + webhook nạp tiền
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me';
const MEMO_PREFIX = (process.env.MEMO_PREFIX || 'shopglow').toLowerCase();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));

const BANK = {
  bin: process.env.BANK_BIN || '970422',
  account: process.env.BANK_ACCOUNT || '403012011',
  accountName: process.env.BANK_ACCOUNT_NAME || 'VU TUAN ANH',
};

const TOPUP_MIN = 5000;
const TOPUP_MAX = 1900000;
const buyLocks = new Set();
const pendingTopups = new Map();

/* ===================== STORAGE ===================== */
function readJson(file, fallback) {
  const p = path.join(DATA, file);
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2), 'utf8');
}
function getProducts() {
  return readJson('products.json', []);
}
function saveProducts(list) {
  writeJson('products.json', list);
}
function getUsers() {
  return readJson('users.json', {});
}
function saveUsers(u) {
  writeJson('users.json', u);
}
function getOrders() {
  return readJson('orders.json', []);
}
function saveOrders(o) {
  writeJson('orders.json', o);
}
function getTopups() {
  return readJson('topups.json', []);
}
function saveTopups(t) {
  writeJson('topups.json', t);
}

function ensureUser(chatId, from = {}) {
  const users = getUsers();
  const id = String(chatId);
  if (!users[id]) {
    users[id] = {
      id,
      balance: 0,
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || id,
      username: from.username || '',
      photo_url: from.photo_url || '',
      totalTopup: 0,
      totalSpent: 0,
      createdAt: new Date().toISOString(),
    };
  } else {
    if (from.first_name || from.username) {
      users[id].name =
        [from.first_name, from.last_name].filter(Boolean).join(' ') || users[id].name;
      if (from.username) users[id].username = from.username;
    }
    if (from.photo_url) users[id].photo_url = from.photo_url;
  }
  saveUsers(users);
  return users[id];
}

function isAdmin(chatId) {
  return ADMIN_IDS.includes(Number(chatId));
}
function money(n) {
  return Number(n || 0).toLocaleString('vi-VN') + ' đ';
}
function stockOf(p) {
  return Array.isArray(p.keys) ? p.keys.filter((k) => String(k).trim()).length : 0;
}
function takeKeys(productId, qty) {
  const products = getProducts();
  const p = products.find((x) => x.id === productId);
  if (!p) return { ok: false, error: 'Sản phẩm không tồn tại' };
  const keys = (p.keys || []).map((k) => String(k).trim()).filter(Boolean);
  if (keys.length < qty) return { ok: false, error: 'Hết hàng / không đủ key' };
  const delivered = keys.slice(0, qty);
  p.keys = keys.slice(qty);
  saveProducts(products);
  return { ok: true, keys: delivered, product: p };
}
function makeMemo() {
  return MEMO_PREFIX + (Math.floor(Math.random() * 99999) + 1);
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ===================== TELEGRAM initData VERIFY ===================== */
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

/** https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function verifyTelegramWebAppData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    // optional: auth_date freshness 24h
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && Date.now() / 1000 - authDate > 86400) return null;
    let user = null;
    if (params.get('user')) {
      try {
        user = JSON.parse(params.get('user'));
      } catch (_) {}
    }
    return { user, auth_date: authDate, raw: initData };
  } catch (e) {
    console.warn('verify initData', e.message);
    return null;
  }
}

/** DEV: cho test ngoài Telegram nếu ALLOW_DEV_AUTH=1 */
function resolveUser(req) {
  const initData =
    req.headers['x-telegram-init-data'] ||
    req.body?.initData ||
    req.query?.initData ||
    '';
  const verified = verifyTelegramWebAppData(initData);
  if (verified && verified.user && verified.user.id) {
    const u = ensureUser(verified.user.id, verified.user);
    return { ok: true, user: u, tg: verified.user };
  }
  if (process.env.ALLOW_DEV_AUTH === '1') {
    const devId = req.headers['x-dev-user'] || 'dev-user';
    const u = ensureUser(devId, { first_name: 'Dev', username: 'dev' });
    return { ok: true, user: u, tg: { id: devId }, dev: true };
  }
  return { ok: false, error: 'Unauthorized — mở shop trong Telegram Mini App' };
}

function authMiddleware(req, res, next) {
  const r = resolveUser(req);
  if (!r.ok) return res.status(401).json(r);
  req.shopUser = r.user;
  req.tgUser = r.tg;
  next();
}

/* ===================== CORE BUSINESS ===================== */
function createTopupForUser(userId, amount) {
  amount = parseInt(amount, 10);
  if (isNaN(amount) || amount < TOPUP_MIN) {
    return { ok: false, error: `Tối thiểu ${money(TOPUP_MIN)}` };
  }
  if (amount > TOPUP_MAX) {
    return { ok: false, error: `Tối đa ${money(TOPUP_MAX)}` };
  }
  const memo = makeMemo();
  pendingTopups.set(memo.toLowerCase(), {
    userId: String(userId),
    amount,
    createdAt: Date.now(),
  });
  setTimeout(() => pendingTopups.delete(memo.toLowerCase()), 30 * 60 * 1000);

  const topups = getTopups();
  topups.unshift({
    id: uuidv4(),
    memo,
    userId: String(userId),
    amount,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  saveTopups(topups.slice(0, 500));

  const qrUrl =
    `https://api.vietqr.io/image/${BANK.bin}-${BANK.account}-compact2.png` +
    `?accountName=${encodeURIComponent(BANK.accountName)}` +
    `&amount=${amount}&addInfo=${encodeURIComponent(memo)}`;

  return {
    ok: true,
    memo,
    amount,
    bank: BANK,
    qrUrl,
    expireMinutes: 30,
  };
}

function creditTopupByMemo(memoRaw, amount, meta = {}) {
  const memo = String(memoRaw || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  let found = null;
  let foundKey = null;
  for (const [k, v] of pendingTopups.entries()) {
    if (memo.includes(k)) {
      found = v;
      foundKey = k;
      break;
    }
  }
  if (!found) {
    const topups = getTopups();
    const row = topups.find(
      (t) => t.status === 'pending' && memo.includes(String(t.memo).toLowerCase())
    );
    if (row) {
      found = { userId: row.userId, amount: row.amount };
      foundKey = String(row.memo).toLowerCase();
    }
  }
  if (!found) return { ok: false, error: 'Không khớp memo pending' };
  const expect = Number(found.amount);
  const got = Number(amount);
  if (!got || got !== expect) {
    return { ok: false, error: `Sai số tiền (cần ${expect}, nhận ${got})` };
  }

  const users = getUsers();
  const u = users[found.userId] || {
    id: found.userId,
    balance: 0,
    totalTopup: 0,
    totalSpent: 0,
    name: found.userId,
  };
  u.balance = (u.balance || 0) + expect;
  u.totalTopup = (u.totalTopup || 0) + expect;
  users[found.userId] = u;
  saveUsers(users);

  if (foundKey) pendingTopups.delete(foundKey);
  const topups = getTopups();
  for (const t of topups) {
    if (
      String(t.memo).toLowerCase() === foundKey ||
      memo.includes(String(t.memo).toLowerCase())
    ) {
      if (t.status === 'pending') {
        t.status = 'paid';
        t.paidAt = new Date().toISOString();
        t.meta = meta;
      }
    }
  }
  saveTopups(topups);

  if (bot) {
    bot
      .sendMessage(
        found.userId,
        `✅ Đã nạp <b>${money(expect)}</b>\nSố dư mới: <b>${money(u.balance)}</b>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
  notifyAdmins(
    `✅ Nạp OK <code>${found.userId}</code> +${money(expect)} · SD ${money(u.balance)}`
  );
  return { ok: true, userId: found.userId, amount: expect, balance: u.balance };
}

function buyForUser(userId, productId, qty = 1) {
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const lockKey = String(userId);
  if (buyLocks.has(lockKey)) return { ok: false, error: 'Đang xử lý đơn trước' };
  buyLocks.add(lockKey);
  try {
    const users = getUsers();
    const u = users[String(userId)];
    if (!u) return { ok: false, error: 'User không tồn tại' };
    const products = getProducts();
    const p = products.find((x) => x.id === productId);
    if (!p || p.active === false) return { ok: false, error: 'Sản phẩm không tồn tại' };
    if (stockOf(p) < qty) return { ok: false, error: 'Hết hàng' };
    const total = p.price * qty;
    if ((u.balance || 0) < total) {
      return {
        ok: false,
        error: 'Số dư không đủ',
        need: total,
        balance: u.balance,
      };
    }
    const taken = takeKeys(productId, qty);
    if (!taken.ok) return taken;

    u.balance -= total;
    u.totalSpent = (u.totalSpent || 0) + total;
    users[String(userId)] = u;
    saveUsers(users);

    const order = {
      id: 'ORD-' + Date.now().toString(36).toUpperCase(),
      userId: String(userId),
      productId: p.id,
      productName: p.name,
      qty,
      amount: total,
      keys: taken.keys,
      status: 'delivered',
      createdAt: new Date().toISOString(),
    };
    const orders = getOrders();
    orders.unshift(order);
    saveOrders(orders.slice(0, 2000));

    notifyAdmins(
      `🛒 Mua <code>${userId}</code> · ${escapeHtml(p.name)} · ${money(total)} · ${order.id}`
    );

    return {
      ok: true,
      order: {
        id: order.id,
        productName: order.productName,
        qty: order.qty,
        amount: order.amount,
        keys: order.keys,
        createdAt: order.createdAt,
      },
      balance: u.balance,
    };
  } finally {
    buyLocks.delete(lockKey);
  }
}

/* ===================== BOT ===================== */
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('[bot] polling ON');
} else {
  console.warn('[bot] thiếu BOT_TOKEN');
}

async function notifyAdmins(text) {
  if (!bot) return;
  for (const id of ADMIN_IDS) {
    try {
      await bot.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.warn('admin notify', e.message);
    }
  }
}

function mainKeyboard(chatId) {
  const rows = [
    [{ text: '🛒 Sản phẩm' }, { text: '💰 Nạp tiền' }],
    [{ text: '👤 Số dư' }, { text: '📦 Lịch sử' }],
    [{ text: '🛡️ Báo lỗi key' }],
  ];
  if (PUBLIC_URL) {
    rows.unshift([
      { text: '📱 Mở Mini App', web_app: { url: PUBLIC_URL + '/app.html' } },
    ]);
  }
  if (isAdmin(chatId)) rows.push([{ text: '⚙️ Admin' }]);
  return { keyboard: rows, resize_keyboard: true };
}

if (bot) {
  bot.onText(/\/start/, async (msg) => {
    const u = ensureUser(msg.chat.id, msg.from);
    let extra = '';
    if (PUBLIC_URL) {
      extra = `\n\n📱 <b>Mini App:</b> ${PUBLIC_URL}/app.html`;
    }
    await bot.sendMessage(
      msg.chat.id,
      `Xin chào <b>${escapeHtml(u.name)}</b>!\nSố dư: <b>${money(u.balance)}</b>${extra}`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard(msg.chat.id) }
    );
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const u = ensureUser(chatId, msg.from);
    try {
      if (text === '👤 Số dư') {
        return bot.sendMessage(
          chatId,
          `💰 Số dư: <b>${money(u.balance)}</b>\nTổng nạp: ${money(u.totalTopup)}\nTổng chi: ${money(u.totalSpent)}`,
          { parse_mode: 'HTML' }
        );
      }
      if (text === '🛒 Sản phẩm') return sendProductList(chatId);
      if (text === '💰 Nạp tiền') {
        return bot.sendMessage(
          chatId,
          `Gửi số tiền (${money(TOPUP_MIN)} – ${money(TOPUP_MAX)}).\nVí dụ: <code>50000</code>`,
          { parse_mode: 'HTML' }
        );
      }
      if (text === '📦 Lịch sử') return sendHistory(chatId);
      if (text === '🛡️ Báo lỗi key') {
        return bot.sendMessage(
          chatId,
          'Gửi: <code>LOI | mã_đơn | mô_tả</code>',
          { parse_mode: 'HTML' }
        );
      }
      if (text === '⚙️ Admin' && isAdmin(chatId)) return sendAdminMenu(chatId);
      if (/^\d{4,8}$/.test(text)) {
        const r = createTopupForUser(chatId, parseInt(text, 10));
        if (!r.ok) return bot.sendMessage(chatId, r.error);
        await bot.sendMessage(
          chatId,
          `💰 Nạp <b>${money(r.amount)}</b>\nNội dung CK: <code>${r.memo}</code>\nSTK: <code>${r.bank.account}</code> · ${escapeHtml(r.bank.accountName)}\n\nQuét QR hoặc CK đúng nội dung. Hệ thống tự cộng tiền.`,
          { parse_mode: 'HTML' }
        );
        if (r.qrUrl) await bot.sendPhoto(chatId, r.qrUrl).catch(() => {});
        return;
      }
      if (/^LOI\s*\|/i.test(text)) return handleWarranty(chatId, text, u);
      if (isAdmin(chatId) && /^ADDKEY\s*\|/i.test(text)) return adminAddKey(chatId, text);
      if (isAdmin(chatId) && /^CONG\s*\|/i.test(text)) return adminCredit(chatId, text);
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, 'Lỗi: ' + (e.message || e));
    }
  });

  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data || '';
    try {
      if (data.startsWith('buy:')) {
        const r = buyForUser(chatId, data.slice(4), 1);
        if (!r.ok) {
          await bot.answerCallbackQuery(q.id, { text: r.error, show_alert: true });
          return;
        }
        await bot.sendMessage(
          chatId,
          `✅ <b>${escapeHtml(r.order.productName)}</b>\nMã: <code>${r.order.id}</code>\n🔑 <code>${escapeHtml(r.order.keys.join('\n'))}</code>\nSD: ${money(r.balance)}`,
          { parse_mode: 'HTML' }
        );
      }
      await bot.answerCallbackQuery(q.id);
    } catch (e) {
      await bot.answerCallbackQuery(q.id, { text: e.message || 'Lỗi' });
    }
  });
}

async function sendProductList(chatId) {
  const products = getProducts().filter((p) => p.active !== false);
  if (!products.length) return bot.sendMessage(chatId, 'Chưa có SP.');
  for (const p of products) {
    const st = stockOf(p);
    await bot.sendMessage(
      chatId,
      `<b>${escapeHtml(p.name)}</b>\n${escapeHtml(p.desc || '')}\nGiá: <b>${money(p.price)}</b>\n${st ? '✅ Còn ' + st : '❌ Hết hàng'}`,
      {
        parse_mode: 'HTML',
        reply_markup:
          st > 0
            ? { inline_keyboard: [[{ text: 'Mua · ' + money(p.price), callback_data: 'buy:' + p.id }]] }
            : undefined,
      }
    );
  }
}

async function sendHistory(chatId) {
  const orders = getOrders()
    .filter((o) => o.userId === String(chatId))
    .slice(0, 10);
  if (!orders.length) return bot.sendMessage(chatId, 'Chưa có đơn.');
  for (const o of orders) {
    await bot.sendMessage(
      chatId,
      `📦 <b>${escapeHtml(o.productName)}</b>\n<code>${o.id}</code>\n${o.createdAt}\n${money(o.amount)}\n🔑 <code>${escapeHtml((o.keys || []).join('\n'))}</code>`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleWarranty(chatId, text, u) {
  const parts = text.split('|').map((s) => s.trim());
  const orderId = parts[1] || '';
  const reason = parts.slice(2).join(' | ') || 'Không rõ';
  const order = getOrders().find((o) => o.id === orderId && o.userId === String(chatId));
  if (!order) return bot.sendMessage(chatId, 'Không tìm thấy đơn.');
  await notifyAdmins(
    `🛡️ BH user <code>${chatId}</code>\nĐơn <code>${orderId}</code>\n${escapeHtml(reason)}`
  );
  await bot.sendMessage(chatId, 'Đã gửi admin.');
}

async function sendAdminMenu(chatId) {
  const products = getProducts();
  const lines = products.map(
    (p) => `• <code>${p.id}</code> ${escapeHtml(p.name)} · ${stockOf(p)} key · ${money(p.price)}`
  );
  await bot.sendMessage(
    chatId,
    `<b>Admin</b>\n${lines.join('\n') || '(trống)'}\n\n<code>ADDKEY | id | key</code>\n<code>CONG | userId | 50000</code>`,
    { parse_mode: 'HTML' }
  );
}

async function adminAddKey(chatId, text) {
  const parts = text.split('|').map((s) => s.trim());
  const pid = parts[1];
  const key = parts.slice(2).join('|').trim();
  if (!pid || !key) return bot.sendMessage(chatId, 'Sai cú pháp');
  const products = getProducts();
  const p = products.find((x) => x.id === pid);
  if (!p) return bot.sendMessage(chatId, 'Không có SP');
  p.keys = p.keys || [];
  p.keys.push(key);
  saveProducts(products);
  await bot.sendMessage(chatId, `OK. Kho ${p.name}: ${stockOf(p)}`);
}

async function adminCredit(chatId, text) {
  const parts = text.split('|').map((s) => s.trim());
  const uid = parts[1];
  const amount = parseInt(parts[2], 10);
  if (!uid || !amount) return bot.sendMessage(chatId, 'Sai cú pháp');
  const users = getUsers();
  const u = users[uid] || {
    id: uid,
    balance: 0,
    totalTopup: 0,
    totalSpent: 0,
    name: uid,
  };
  u.balance += amount;
  u.totalTopup += amount;
  users[uid] = u;
  saveUsers(users);
  if (bot) {
    bot
      .sendMessage(uid, `Admin cộng <b>${money(amount)}</b>. SD: <b>${money(u.balance)}</b>`, {
        parse_mode: 'HTML',
      })
      .catch(() => {});
  }
  await bot.sendMessage(chatId, `Đã cộng ${money(amount)} → ${uid}`);
}

/* ===================== HTTP ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/', (_req, res) => {
  res.redirect('/app.html');
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    bot: !!bot,
    publicUrl: PUBLIC_URL || null,
    products: getProducts().length,
  });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const u = req.shopUser;
  res.json({
    ok: true,
    id: u.id,
    name: u.name,
    username: u.username,
    photo_url: u.photo_url || (req.tgUser && req.tgUser.photo_url) || '',
    balance: u.balance || 0,
    totalTopup: u.totalTopup || 0,
    totalSpent: u.totalSpent || 0,
  });
});

app.get('/api/products', authMiddleware, (_req, res) => {
  const list = getProducts()
    .filter((p) => p.active !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category || '',
      desc: p.desc || '',
      stock: stockOf(p),
    }));
  res.json({ ok: true, products: list });
});

app.post('/api/topup', authMiddleware, (req, res) => {
  const r = createTopupForUser(req.shopUser.id, req.body?.amount);
  if (!r.ok) return res.status(400).json(r);
  notifyAdmins(
    `⏳ MiniApp nạp chờ <code>${req.shopUser.id}</code> · ${money(r.amount)} · <code>${r.memo}</code>`
  );
  res.json(r);
});

app.post('/api/buy', authMiddleware, (req, res) => {
  const r = buyForUser(req.shopUser.id, req.body?.productId, req.body?.qty || 1);
  if (!r.ok) return res.status(400).json(r);
  if (bot) {
    bot
      .sendMessage(
        req.shopUser.id,
        `✅ Mini App giao key\n<code>${r.order.id}</code>\n🔑 <code>${escapeHtml(r.order.keys.join('\n'))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
  res.json(r);
});

app.get('/api/orders', authMiddleware, (req, res) => {
  const list = getOrders()
    .filter((o) => o.userId === String(req.shopUser.id))
    .slice(0, 50)
    .map((o) => ({
      id: o.id,
      productName: o.productName,
      qty: o.qty,
      amount: o.amount,
      keys: o.keys || [],
      createdAt: o.createdAt,
      status: o.status,
    }));
  res.json({ ok: true, orders: list });
});

app.post('/api/warranty', authMiddleware, async (req, res) => {
  const orderId = req.body?.orderId || '';
  const reason = req.body?.reason || 'Không rõ';
  const order = getOrders().find(
    (o) => o.id === orderId && o.userId === String(req.shopUser.id)
  );
  if (!order) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn' });
  await notifyAdmins(
    `🛡️ MiniApp BH <code>${req.shopUser.id}</code>\nĐơn <code>${orderId}</code>\n${escapeHtml(reason)}`
  );
  res.json({ ok: true });
});

app.post('/webhook/payment', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.query.secret || '';
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const body = req.body || {};
  const amount =
    body.transferAmount || body.amount || body.Amount || body.transaction_amount || body.money;
  const content =
    body.content ||
    body.description ||
    body.Description ||
    body.memo ||
    body.comment ||
    body.body ||
    '';
  const result = creditTopupByMemo(content, amount, {
    ref: body.referenceCode || body.id || null,
  });
  console.log('[webhook]', content, amount, result);
  return res.json(result);
});

app.post('/api/admin/credit', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || '';
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  const { userId, amount } = req.body || {};
  if (!userId || !amount) return res.status(400).json({ ok: false });
  const users = getUsers();
  const u = users[String(userId)] || {
    id: String(userId),
    balance: 0,
    totalTopup: 0,
    totalSpent: 0,
    name: String(userId),
  };
  u.balance += Number(amount);
  u.totalTopup += Number(amount);
  users[String(userId)] = u;
  saveUsers(users);
  res.json({ ok: true, balance: u.balance });
});

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] Mini App: ${PUBLIC_URL || 'http://localhost:' + PORT}/app.html`);
  console.log(`[server] Webhook POST /webhook/payment`);
  if (!BOT_TOKEN) console.warn('[server] BOT_TOKEN trống');
  if (!ADMIN_IDS.length) console.warn('[server] ADMIN_IDS trống');
});
