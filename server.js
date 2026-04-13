const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { spawn } = require('child_process');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zenriinz_secret_2025';
const USERS_FILE = './data/users.json';
const BOTS_DIR = './bots';

// ── INIT DIRS ──
['./data', BOTS_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

app.use(express.json());
app.use(express.static('public'));

// ── MULTER (رفع الملفات) ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(BOTS_DIR, req.user.username);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── JWT MIDDLEWARE ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'جلسة منتهية' });
  }
}

// ── USERS HELPERS ──
function getUsers() { return JSON.parse(fs.readFileSync(USERS_FILE)); }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

// ════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'الحقول مطلوبة' });
  if (username.length < 3) return res.status(400).json({ error: 'الاسم قصير جداً' });
  if (password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
  const users = getUsers();
  if (users[username]) return res.status(400).json({ error: 'الاسم محجوز' });
  users[username] = { password: await bcrypt.hash(password, 10), created: Date.now() };
  saveUsers(users);
  fs.mkdirSync(path.join(BOTS_DIR, username), { recursive: true });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  if (!users[username]) return res.status(400).json({ error: 'المستخدم غير موجود' });
  const ok = await bcrypt.compare(password, users[username].password);
  if (!ok) return res.status(400).json({ error: 'كلمة مرور خاطئة' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

// ════════════════════════════════
// FILES ROUTES
// ════════════════════════════════
app.get('/api/files', authMiddleware, (req, res) => {
  const dir = path.join(BOTS_DIR, req.user.username);
  fs.mkdirSync(dir, { recursive: true });
  const items = fs.readdirSync(dir).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, isDir: stat.isDirectory(), date: stat.mtime };
  });
  res.json(items);
});

app.post('/api/files/upload', authMiddleware, upload.array('files'), (req, res) => {
  res.json({ uploaded: req.files.map(f => f.originalname) });
});

app.delete('/api/files/:name', authMiddleware, (req, res) => {
  const target = path.join(BOTS_DIR, req.user.username, req.params.name);
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'الملف غير موجود' });
  fs.rmSync(target, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/files/download/:name', authMiddleware, (req, res) => {
  const file = path.join(BOTS_DIR, req.user.username, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.download(file);
});

// تعديل ملف JS
app.get('/api/files/read/:name', authMiddleware, (req, res) => {
  const file = path.join(BOTS_DIR, req.user.username, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.json({ content: fs.readFileSync(file, 'utf-8') });
});

app.post('/api/files/write/:name', authMiddleware, (req, res) => {
  const file = path.join(BOTS_DIR, req.user.username, req.params.name);
  fs.writeFileSync(file, req.body.content);
  res.json({ ok: true });
});

// ════════════════════════════════
// BOT PROCESS MANAGEMENT
// ════════════════════════════════
const botProcesses = {}; // username -> { proc, waSocket, status }

function getSocketRoom(username) { return `user_${username}`; }

function emitLog(username, text, type = 'info') {
  io.to(getSocketRoom(username)).emit('console_log', { text, type, time: new Date().toTimeString().slice(0,8) });
}

app.post('/api/bot/start', authMiddleware, async (req, res) => {
  const { username } = req.user;
  if (botProcesses[username]?.status === 'running') {
    return res.status(400).json({ error: 'البوت يعمل بالفعل' });
  }
  const botDir = path.join(BOTS_DIR, username);
  const mainFile = path.join(botDir, 'main.js');
  if (!fs.existsSync(mainFile)) {
    return res.status(400).json({ error: 'main.js غير موجود — ارفع ملفات البوت أولاً' });
  }

  emitLog(username, '🚀 جارٍ تشغيل البوت...', 'system');

  const proc = spawn('node', [mainFile], {
    cwd: botDir,
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  botProcesses[username] = { proc, status: 'running', startTime: Date.now() };

  proc.stdout.on('data', data => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => emitLog(username, line, 'info'));
  });

  proc.stderr.on('data', data => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => emitLog(username, line, 'error'));
  });

  proc.on('close', code => {
    emitLog(username, `[BOT] العملية انتهت برمز: ${code}`, 'warn');
    if (botProcesses[username]) botProcesses[username].status = 'stopped';
    io.to(getSocketRoom(username)).emit('bot_status', { status: 'stopped' });
  });

  io.to(getSocketRoom(username)).emit('bot_status', { status: 'running' });
  res.json({ ok: true });
});

app.post('/api/bot/stop', authMiddleware, (req, res) => {
  const { username } = req.user;
  const bot = botProcesses[username];
  if (!bot || bot.status !== 'running') return res.status(400).json({ error: 'البوت متوقف' });
  bot.proc.kill('SIGTERM');
  setTimeout(() => { try { bot.proc.kill('SIGKILL'); } catch {} }, 3000);
  bot.status = 'stopped';
  emitLog(username, '[BOT] تم إيقاف البوت.', 'warn');
  io.to(getSocketRoom(username)).emit('bot_status', { status: 'stopped' });
  res.json({ ok: true });
});

app.post('/api/bot/restart', authMiddleware, async (req, res) => {
  const { username } = req.user;
  const bot = botProcesses[username];
  if (bot?.status === 'running') {
    bot.proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
  }
  delete botProcesses[username];
  // re-trigger start
  req.body = {};
  emitLog(username, '[BOT] جارٍ إعادة التشغيل...', 'warn');
  setTimeout(() => {
    const fakeReq = { user: { username }, body: {} };
    const fakeRes = { status: () => ({ json: () => {} }), json: () => {} };
    // Call start logic again via internal request
  }, 500);
  res.json({ ok: true, message: 'أرسل طلب start مجدداً' });
});

app.get('/api/bot/status', authMiddleware, (req, res) => {
  const bot = botProcesses[req.user.username];
  const status = bot?.status || 'stopped';
  const uptime = bot?.startTime ? Math.floor((Date.now() - bot.startTime) / 1000) : 0;
  res.json({ status, uptime });
});

// ════════════════════════════════
// WHATSAPP QR (Baileys)
// ════════════════════════════════
const waSessions = {};

app.post('/api/whatsapp/connect', authMiddleware, async (req, res) => {
  const { username } = req.user;
  if (waSessions[username]?.connected) return res.json({ connected: true });

  const sessionDir = path.join('./data/sessions', username);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    waSessions[username] = { sock, connected: false };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrImage = await qrcode.toDataURL(qr);
        io.to(getSocketRoom(username)).emit('whatsapp_qr', { qr: qrImage });
        emitLog(username, '[WhatsApp] امسح QR Code لربط رقمك', 'system');
      }
      if (connection === 'open') {
        waSessions[username].connected = true;
        emitLog(username, '[WhatsApp] ✅ تم الربط بنجاح!', 'info');
        io.to(getSocketRoom(username)).emit('whatsapp_status', { connected: true });
      }
      if (connection === 'close') {
        waSessions[username].connected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        emitLog(username, `[WhatsApp] انقطع الاتصال. إعادة اتصال: ${shouldReconnect}`, 'warn');
        io.to(getSocketRoom(username)).emit('whatsapp_status', { connected: false });
        if (shouldReconnect) {
          setTimeout(() => {
            const fakeReq = { user: { username } };
            // reconnect logic
          }, 3000);
        }
      }
    });
    res.json({ ok: true, message: 'جارٍ توليد QR...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/disconnect', authMiddleware, async (req, res) => {
  const { username } = req.user;
  const session = waSessions[username];
  if (session?.sock) {
    await session.sock.logout().catch(() => {});
    delete waSessions[username];
    const sessionDir = path.join('./data/sessions', username);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    emitLog(username, '[WhatsApp] تم قطع الارتباط وحذف الجلسة.', 'warn');
  }
  res.json({ ok: true });
});

// ════════════════════════════════
// SOCKET.IO
// ════════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('غير مصرح'));
  }
});

io.on('connection', socket => {
  const { username } = socket.user;
  socket.join(getSocketRoom(username));
  socket.emit('console_log', { text: `✅ متصل بالسيرفر — مرحباً ${username}`, type: 'system', time: new Date().toTimeString().slice(0,8) });

  // Console command from frontend
  socket.on('console_cmd', ({ cmd }) => {
    const bot = botProcesses[username];
    if (!bot || bot.status !== 'running') {
      socket.emit('console_log', { text: '[ERROR] البوت غير مشغّل', type: 'error', time: new Date().toTimeString().slice(0,8) });
      return;
    }
    bot.proc.stdin?.write(cmd + '\n');
  });
});

// ════════════════════════════════
// START SERVER
// ════════════════════════════════
server.listen(PORT, () => {
  console.log(`✅ Zenriinz Host يعمل على المنفذ ${PORT}`);
});
