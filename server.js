const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const db = new Database('./slot.db');
const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-in-production';

// Database setup
db.exec(`
  CREATE TABLE IF NOT EXISTS drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_hash TEXT NOT NULL,
    mode TEXT DEFAULT 'type',
    char_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS streaks (
    device_hash TEXT PRIMARY KEY,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_drop_date TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_drops_date ON drops(created_at);
  CREATE INDEX IF NOT EXISTS idx_drops_device ON drops(device_hash, created_at);
`);

// Default config
const defaults = {
  type_enabled: 'true',
  speak_enabled: 'true',
  draw_enabled: 'true',
  streaks_enabled: 'true',
  global_drops_visible: 'true',
  live_counter_visible: 'true',
  seasonal_accent: 'true',
  max_chars: '200',
  drops_per_day: '1',
  announcement: '',
};

for (const [key, value] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

// Middleware
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' },
});
app.use('/api/', limiter);

function getDeviceHash(req) {
  const raw = (req.ip || '') + (req.headers['user-agent'] || '');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Public API

app.get('/api/status', (req, res) => {
  const deviceHash = getDeviceHash(req);
  const today = new Date().toISOString().slice(0, 10);

  const { count: todayCount } = db.prepare(
    "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = ?"
  ).get(today);

  const { count: userDrops } = db.prepare(
    "SELECT COUNT(*) as count FROM drops WHERE device_hash = ? AND DATE(created_at) = ?"
  ).get(deviceHash, today);

  const config = {};
  const rows = db.prepare('SELECT key, value FROM config').all();
  for (const row of rows) config[row.key] = row.value;

  const streak = db.prepare('SELECT * FROM streaks WHERE device_hash = ?').get(deviceHash);

  res.json({
    todayCount,
    hasDroppedToday: userDrops >= parseInt(config.drops_per_day || '1'),
    streak: streak?.current_streak || 0,
    longestStreak: streak?.longest_streak || 0,
    config,
  });
});

app.post('/api/drop', (req, res) => {
  const deviceHash = getDeviceHash(req);
  const today = new Date().toISOString().slice(0, 10);
  const { mode = 'type', charCount = 0 } = req.body;

  const config = {};
  const rows = db.prepare('SELECT key, value FROM config').all();
  for (const row of rows) config[row.key] = row.value;

  const maxDrops = parseInt(config.drops_per_day || '1');

  const { count: userDrops } = db.prepare(
    "SELECT COUNT(*) as count FROM drops WHERE device_hash = ? AND DATE(created_at) = ?"
  ).get(deviceHash, today);

  if (userDrops >= maxDrops) {
    return res.status(429).json({ error: 'Already dropped today' });
  }

  const validModes = ['type', 'speak', 'draw'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  if (config[`${mode}_enabled`] === 'false') {
    return res.status(403).json({ error: 'This mode is currently disabled' });
  }

  db.prepare(
    "INSERT INTO drops (device_hash, mode, char_count) VALUES (?, ?, ?)"
  ).run(deviceHash, mode, Math.min(charCount, parseInt(config.max_chars || '200')));

  const streak = db.prepare('SELECT * FROM streaks WHERE device_hash = ?').get(deviceHash);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (streak) {
    const newStreak = streak.last_drop_date === yesterday
      ? streak.current_streak + 1
      : streak.last_drop_date === today
        ? streak.current_streak
        : 1;
    const longest = Math.max(newStreak, streak.longest_streak);

    db.prepare(
      "UPDATE streaks SET current_streak = ?, longest_streak = ?, last_drop_date = ? WHERE device_hash = ?"
    ).run(newStreak, longest, today, deviceHash);
  } else {
    db.prepare(
      "INSERT INTO streaks (device_hash, current_streak, longest_streak, last_drop_date) VALUES (?, 1, 1, ?)"
    ).run(deviceHash, today);
  }

  const { count: todayCount } = db.prepare(
    "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = ?"
  ).get(today);

  res.json({ success: true, todayCount });
});

app.get('/api/count', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { count } = db.prepare(
    "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = ?"
  ).get(today);
  res.json({ count });
});

// Admin API

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const todayCount = db.prepare("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) = ?").get(today).c;
  const yesterdayCount = db.prepare("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) = ?").get(yesterday).c;
  const weekCount = db.prepare("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) >= ?").get(weekAgo).c;
  const allTime = db.prepare("SELECT COUNT(*) as c FROM drops").get().c;

  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
    FROM drops WHERE DATE(created_at) = ?
    GROUP BY hour ORDER BY hour
  `).all(today);

  const modes = db.prepare(`
    SELECT mode, COUNT(*) as count FROM drops WHERE DATE(created_at) = ?
    GROUP BY mode
  `).all(today);

  const recent = db.prepare(`
    SELECT mode, char_count, created_at FROM drops
    ORDER BY created_at DESC LIMIT 20
  `).all();

  const uniqueToday = db.prepare(
    "SELECT COUNT(DISTINCT device_hash) as c FROM drops WHERE DATE(created_at) = ?"
  ).get(today).c;

  res.json({
    today: todayCount,
    yesterday: yesterdayCount,
    thisWeek: weekCount,
    allTime,
    uniqueToday,
    hourly,
    modes,
    recent,
  });
});

app.post('/api/admin/drop', requireAdmin, (req, res) => {
  const { mode = 'type', charCount = 0 } = req.body;
  db.prepare(
    "INSERT INTO drops (device_hash, mode, char_count) VALUES (?, ?, ?)"
  ).run('admin', mode, charCount);
  res.json({ success: true });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  const config = {};
  const rows = db.prepare('SELECT key, value FROM config').all();
  for (const row of rows) config[row.key] = row.value;
  res.json(config);
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, String(value));
    }
  });
  transaction();
  res.json({ success: true });
});

app.post('/api/admin/reset-streaks', requireAdmin, (req, res) => {
  db.prepare('UPDATE streaks SET current_streak = 0').run();
  res.json({ success: true });
});

app.post('/api/admin/reset-counter', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("DELETE FROM drops WHERE DATE(created_at) = ?").run(today);
  res.json({ success: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`slot. backend running on port ${PORT}`);
});