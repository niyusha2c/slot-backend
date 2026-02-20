const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-in-production';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS drops (
        id SERIAL PRIMARY KEY,
        device_hash TEXT NOT NULL,
        mode TEXT DEFAULT 'type',
        char_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      await client.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, value]
      );
    }
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

initDB().catch(console.error);

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

app.get('/api/status', async (req, res) => {
  try {
    const deviceHash = getDeviceHash(req);
    const today = new Date().toISOString().slice(0, 10);

    const todayResult = await pool.query(
      "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = $1",
      [today]
    );
    const todayCount = parseInt(todayResult.rows[0].count);

    const userResult = await pool.query(
      "SELECT COUNT(*) as count FROM drops WHERE device_hash = $1 AND DATE(created_at) = $2",
      [deviceHash, today]
    );
    const userDrops = parseInt(userResult.rows[0].count);

    const configResult = await pool.query('SELECT key, value FROM config');
    const config = {};
    for (const row of configResult.rows) config[row.key] = row.value;

    const streakResult = await pool.query(
      'SELECT * FROM streaks WHERE device_hash = $1',
      [deviceHash]
    );
    const streak = streakResult.rows[0];

    res.json({
      todayCount,
      hasDroppedToday: userDrops >= parseInt(config.drops_per_day || '1'),
      streak: streak?.current_streak || 0,
      longestStreak: streak?.longest_streak || 0,
      config,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/drop', async (req, res) => {
  try {
    const deviceHash = getDeviceHash(req);
    const today = new Date().toISOString().slice(0, 10);
    const { mode = 'type', charCount = 0 } = req.body;

    const configResult = await pool.query('SELECT key, value FROM config');
    const config = {};
    for (const row of configResult.rows) config[row.key] = row.value;

    const maxDrops = parseInt(config.drops_per_day || '1');

    const userResult = await pool.query(
      "SELECT COUNT(*) as count FROM drops WHERE device_hash = $1 AND DATE(created_at) = $2",
      [deviceHash, today]
    );
    const userDrops = parseInt(userResult.rows[0].count);

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

    await pool.query(
      "INSERT INTO drops (device_hash, mode, char_count) VALUES ($1, $2, $3)",
      [deviceHash, mode, Math.min(charCount, parseInt(config.max_chars || '200'))]
    );

    // Update streak
    const streakResult = await pool.query(
      'SELECT * FROM streaks WHERE device_hash = $1',
      [deviceHash]
    );
    const streak = streakResult.rows[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    if (streak) {
      const newStreak = streak.last_drop_date === yesterday
        ? streak.current_streak + 1
        : streak.last_drop_date === today
          ? streak.current_streak
          : 1;
      const longest = Math.max(newStreak, streak.longest_streak);

      await pool.query(
        "UPDATE streaks SET current_streak = $1, longest_streak = $2, last_drop_date = $3 WHERE device_hash = $4",
        [newStreak, longest, today, deviceHash]
      );
    } else {
      await pool.query(
        "INSERT INTO streaks (device_hash, current_streak, longest_streak, last_drop_date) VALUES ($1, 1, 1, $2)",
        [deviceHash, today]
      );
    }

    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = $1",
      [today]
    );

    res.json({ success: true, todayCount: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/count', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM drops WHERE DATE(created_at) = $1",
      [today]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const todayCount = (await pool.query("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) = $1", [today])).rows[0].c;
    const yesterdayCount = (await pool.query("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) = $1", [yesterday])).rows[0].c;
    const weekCount = (await pool.query("SELECT COUNT(*) as c FROM drops WHERE DATE(created_at) >= $1", [weekAgo])).rows[0].c;
    const allTime = (await pool.query("SELECT COUNT(*) as c FROM drops")).rows[0].c;

    const hourly = (await pool.query(`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as count
      FROM drops WHERE DATE(created_at) = $1
      GROUP BY hour ORDER BY hour
    `, [today])).rows;

    const modes = (await pool.query(`
      SELECT mode, COUNT(*) as count FROM drops WHERE DATE(created_at) = $1
      GROUP BY mode
    `, [today])).rows;

    const recent = (await pool.query(`
      SELECT mode, char_count, created_at FROM drops
      ORDER BY created_at DESC LIMIT 20
    `)).rows;

    const uniqueToday = (await pool.query(
      "SELECT COUNT(DISTINCT device_hash) as c FROM drops WHERE DATE(created_at) = $1",
      [today]
    )).rows[0].c;

    res.json({
      today: parseInt(todayCount),
      yesterday: parseInt(yesterdayCount),
      thisWeek: parseInt(weekCount),
      allTime: parseInt(allTime),
      uniqueToday: parseInt(uniqueToday),
      hourly,
      modes,
      recent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/drop', requireAdmin, async (req, res) => {
  try {
    const { mode = 'type', charCount = 0 } = req.body;
    await pool.query(
      "INSERT INTO drops (device_hash, mode, char_count) VALUES ($1, $2, $3)",
      ['admin', mode, charCount]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM config');
    const config = {};
    for (const row of result.rows) config[row.key] = row.value;
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, String(value)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/reset-streaks', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE streaks SET current_streak = 0');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/reset-counter', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query("DELETE FROM drops WHERE DATE(created_at) = $1", [today]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`slot. backend running on port ${PORT}`);
});