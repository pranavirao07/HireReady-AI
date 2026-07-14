// HireReady AI — backend server
// -----------------------------------------------------------------------------
// Zero npm dependencies on purpose: uses only Node's built-in modules
// (node:http, node:sqlite, node:crypto). This means `node server.js` just works,
// with no `npm install` step and no native binary compilation to fail.
//
// Requires Node.js 22.5+ (for the built-in node:sqlite module). If your Node
// version is older, this will automatically fall back to a JSON-file-based
// store in ./data.json instead of a real database — everything still works,
// just without real SQL underneath. Run `node --version` to check.
// -----------------------------------------------------------------------------

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'hireready.db');
const JSON_FALLBACK_PATH = path.join(__dirname, 'data.json');

// -----------------------------------------------------------------------------
// Data layer — tries node:sqlite first, falls back to a JSON file if the
// current Node version doesn't have it.
// -----------------------------------------------------------------------------
let db = null;
let usingSqlite = false;

function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      score INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS resume_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      ats_score INTEGER NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  usingSqlite = true;
  console.log('Using real SQLite database at', DB_PATH);
}

// Minimal JSON-file fallback with the same shape of operations as the SQLite
// path below. Only used automatically if node:sqlite isn't available.
let jsonData = { users: [], sessions: [], scores: [], resumeAnalyses: [], nextUserId: 1, nextScoreId: 1, nextResumeAnalysisId: 1 };

function loadJsonFallback() {
  if (fs.existsSync(JSON_FALLBACK_PATH)) {
    const loaded = JSON.parse(fs.readFileSync(JSON_FALLBACK_PATH, 'utf8'));
    // Merge onto the defaults rather than replacing outright, so a data.json
    // saved before this feature existed doesn't lose newly-added fields.
    jsonData = Object.assign({}, jsonData, loaded);
  }
  console.log('node:sqlite unavailable — using JSON file fallback at', JSON_FALLBACK_PATH);
}
function saveJsonFallback() {
  fs.writeFileSync(JSON_FALLBACK_PATH, JSON.stringify(jsonData, null, 2));
}

try {
  initSqlite();
} catch (e) {
  loadJsonFallback();
}

// -----------------------------------------------------------------------------
// Password hashing — Node's built-in scrypt (no bcrypt dependency needed).
// -----------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// -----------------------------------------------------------------------------
// Data access helpers (branch on usingSqlite so the rest of the code below
// doesn't need to care which storage backend is active)
// -----------------------------------------------------------------------------
function createUser(name, email, password) {
  const { hash, salt } = hashPassword(password);
  const created_at = new Date().toISOString();
  if (usingSqlite) {
    try {
      const stmt = db.prepare('INSERT INTO users (name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)');
      const info = stmt.run(name, email.toLowerCase(), hash, salt, created_at);
      return { id: Number(info.lastInsertRowid), name, email };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return null; // email already exists
      throw e;
    }
  } else {
    if (jsonData.users.find(u => u.email === email.toLowerCase())) return null;
    const user = { id: jsonData.nextUserId++, name, email: email.toLowerCase(), password_hash: hash, password_salt: salt, created_at };
    jsonData.users.push(user);
    saveJsonFallback();
    return { id: user.id, name, email: user.email };
  }
}

function findUserByEmail(email) {
  if (usingSqlite) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email.toLowerCase()) || null;
  }
  return jsonData.users.find(u => u.email === email.toLowerCase()) || null;
}

function findUserById(id) {
  if (usingSqlite) {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id) || null;
  }
  return jsonData.users.find(u => u.id === id) || null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created_at = new Date().toISOString();
  if (usingSqlite) {
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, created_at);
  } else {
    jsonData.sessions.push({ token, user_id: userId, created_at });
    saveJsonFallback();
  }
  return token;
}

function getSession(token) {
  if (usingSqlite) {
    const stmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
    return stmt.get(token) || null;
  }
  return jsonData.sessions.find(s => s.token === token) || null;
}

function deleteSession(token) {
  if (usingSqlite) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  } else {
    jsonData.sessions = jsonData.sessions.filter(s => s.token !== token);
    saveJsonFallback();
  }
}

function addScore(userId, category, score) {
  const created_at = new Date().toISOString();
  if (usingSqlite) {
    db.prepare('INSERT INTO scores (user_id, category, score, created_at) VALUES (?, ?, ?, ?)').run(userId, category, score, created_at);
  } else {
    jsonData.scores.push({ id: jsonData.nextScoreId++, user_id: userId, category, score, created_at });
    saveJsonFallback();
  }
}

function getScoresForUser(userId) {
  if (usingSqlite) {
    const stmt = db.prepare('SELECT * FROM scores WHERE user_id = ? ORDER BY created_at ASC');
    return stmt.all(userId);
  }
  return jsonData.scores.filter(s => s.user_id === userId);
}

function addResumeAnalysis(userId, fileName, overallScore, atsScore, analysisJson) {
  const created_at = new Date().toISOString();
  if (usingSqlite) {
    db.prepare('INSERT INTO resume_analyses (user_id, file_name, overall_score, ats_score, analysis_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, fileName, overallScore, atsScore, analysisJson, created_at);
  } else {
    jsonData.resumeAnalyses.push({
      id: jsonData.nextResumeAnalysisId++, user_id: userId, file_name: fileName,
      overall_score: overallScore, ats_score: atsScore, analysis_json: analysisJson, created_at
    });
    saveJsonFallback();
  }
}

function getResumeAnalysesForUser(userId) {
  if (usingSqlite) {
    const stmt = db.prepare('SELECT * FROM resume_analyses WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId);
  }
  return jsonData.resumeAnalyses.filter(a => a.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// -----------------------------------------------------------------------------
// Dashboard computation — real numbers derived from real stored scores,
// same logic the frontend used to fake with in-memory session state.
// -----------------------------------------------------------------------------
function computeDashboard(userId) {
  const scores = getScoresForUser(userId);
  const byCategory = {};
  scores.forEach(s => {
    if (!byCategory[s.category]) byCategory[s.category] = { total: 0, count: 0 };
    byCategory[s.category].total += s.score;
    byCategory[s.category].count += 1;
  });
  const categoryAverages = {};
  Object.keys(byCategory).forEach(cat => {
    categoryAverages[cat] = Math.round(byCategory[cat].total / byCategory[cat].count);
  });

  const overall = scores.length ? Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length) : null;

  // Streak = number of consecutive calendar days (ending today) with at least one score.
  const daysWithActivity = new Set(scores.map(s => s.created_at.slice(0, 10)));
  let streak = 0;
  let cursor = new Date();
  while (true) {
    const dayStr = cursor.toISOString().slice(0, 10);
    if (daysWithActivity.has(dayStr)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  const xp = 240 + scores.length * 40;
  const level = 7 + Math.floor(scores.length / 3);

  return { categoryAverages, overall, streak, xp, level, totalPracticed: scores.length };
}

// -----------------------------------------------------------------------------
// Input validation — kept simple and dependency-free on purpose.
// -----------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_CATEGORIES = new Set([
  'interview', 'gd', 'resume', 'grammar', 'vocabulary', 'email', 'coding',
  'aptitude_quant', 'aptitude_logical', 'aptitude_verbal', 'speaking'
]);

function validateSignup(body) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name) errors.push('Name is required.');
  else if (name.length > 100) errors.push('Name is too long.');

  if (!email) errors.push('Email is required.');
  else if (!EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
  else if (email.length > 200) errors.push('Email is too long.');

  if (!password) errors.push('Password is required.');
  else if (password.length < 8) errors.push('Password must be at least 8 characters.');
  else if (password.length > 200) errors.push('Password is too long.');

  return { errors, name, email, password };
}

function validateLogin(body) {
  const errors = [];
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email) errors.push('Email is required.');
  if (!password) errors.push('Password is required.');
  return { errors, email, password };
}

function validateScore(body) {
  const errors = [];
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const score = typeof body.score === 'number' ? body.score : NaN;

  if (!category) errors.push('Category is required.');
  else if (!ALLOWED_CATEGORIES.has(category)) errors.push('Unrecognized category: ' + category);

  if (Number.isNaN(score)) errors.push('Score must be a number.');
  else if (score < 0 || score > 100) errors.push('Score must be between 0 and 100.');

  return { errors, category, score };
}

function validateResumeAnalysis(body) {
  const errors = [];
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const overallScore = typeof body.overallScore === 'number' ? body.overallScore : NaN;
  const atsScore = typeof body.atsScore === 'number' ? body.atsScore : NaN;
  const analysis = body.analysis;

  if (!fileName) errors.push('fileName is required.');
  else if (fileName.length > 255) errors.push('fileName is too long.');

  if (Number.isNaN(overallScore) || overallScore < 0 || overallScore > 100) errors.push('overallScore must be a number between 0 and 100.');
  if (Number.isNaN(atsScore) || atsScore < 0 || atsScore > 100) errors.push('atsScore must be a number between 0 and 100.');

  if (!analysis || typeof analysis !== 'object') errors.push('analysis object is required.');
  else {
    const analysisStr = JSON.stringify(analysis);
    if (analysisStr.length > 50000) errors.push('analysis payload is too large.');
  }

  return { errors, fileName, overallScore, atsScore, analysis };
}

// -----------------------------------------------------------------------------
// Rate limiting — simple in-memory sliding window, keyed by IP + endpoint.
// Deliberately basic (no dependency, resets if the server restarts) but enough
// to stop naive brute-force attempts against login/signup.
// -----------------------------------------------------------------------------
const rateLimitHits = new Map(); // key: "ip:endpoint" -> array of timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // max attempts per window

function isRateLimited(ip, endpoint) {
  const key = ip + ':' + endpoint;
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(key, hits);
  return hits.length > RATE_LIMIT_MAX;
}

// -----------------------------------------------------------------------------
// Tiny HTTP router (no Express — just enough routing logic, built on node:http)
// -----------------------------------------------------------------------------
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const session = getSession(token);
  if (!session) return null;
  return findUserById(session.user_id);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const clientIp = req.socket.remoteAddress || 'unknown';

  try {
    // ---- POST /api/signup ----
    if (url.pathname === '/api/signup' && req.method === 'POST') {
      if (isRateLimited(clientIp, 'signup')) {
        return sendJson(res, 429, { error: 'Too many signup attempts. Please try again later.' });
      }
      const body = await readBody(req);
      const { errors, name, email, password } = validateSignup(body);
      if (errors.length) return sendJson(res, 400, { error: errors[0], errors });
      const user = createUser(name, email, password);
      if (!user) return sendJson(res, 409, { error: 'An account with that email already exists' });
      const token = createSession(user.id);
      return sendJson(res, 201, { token, user });
    }

    // ---- POST /api/login ----
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (isRateLimited(clientIp, 'login')) {
        return sendJson(res, 429, { error: 'Too many login attempts. Please try again later.' });
      }
      const body = await readBody(req);
      const { errors, email, password } = validateLogin(body);
      if (errors.length) return sendJson(res, 400, { error: errors[0], errors });
      const user = findUserByEmail(email);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
        return sendJson(res, 401, { error: 'Invalid email or password' });
      }
      const token = createSession(user.id);
      return sendJson(res, 200, { token, user: { id: user.id, name: user.name, email: user.email } });
    }

    // ---- POST /api/logout ----
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token) deleteSession(token);
      return sendJson(res, 200, { ok: true });
    }

    // ---- GET /api/me ----
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      return sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
    }

    // ---- POST /api/scores ----
    if (url.pathname === '/api/scores' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      const body = await readBody(req);
      const { errors, category, score } = validateScore(body);
      if (errors.length) return sendJson(res, 400, { error: errors[0], errors });
      addScore(user.id, category, Math.round(score));
      return sendJson(res, 201, { ok: true });
    }

    // ---- GET /api/scores ----
    if (url.pathname === '/api/scores' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      return sendJson(res, 200, { scores: getScoresForUser(user.id) });
    }

    // ---- POST /api/resume-analyses ----
    if (url.pathname === '/api/resume-analyses' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      const body = await readBody(req);
      const { errors, fileName, overallScore, atsScore, analysis } = validateResumeAnalysis(body);
      if (errors.length) return sendJson(res, 400, { error: errors[0], errors });
      addResumeAnalysis(user.id, fileName, Math.round(overallScore), Math.round(atsScore), JSON.stringify(analysis));
      return sendJson(res, 201, { ok: true });
    }

    // ---- GET /api/resume-analyses ----
    if (url.pathname === '/api/resume-analyses' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      const rows = getResumeAnalysesForUser(user.id);
      const parsed = rows.map(r => ({
        id: r.id,
        fileName: r.file_name,
        overallScore: r.overall_score,
        atsScore: r.ats_score,
        analysis: JSON.parse(r.analysis_json),
        createdAt: r.created_at
      }));
      return sendJson(res, 200, { analyses: parsed });
    }

    // ---- GET /api/dashboard ----
    if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
      return sendJson(res, 200, computeDashboard(user.id));
    }

    // ---- GET /api/health ----
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, storage: usingSqlite ? 'sqlite' : 'json-file' });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err.message === 'Invalid JSON body') {
      return sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    }
    console.error(err);
    return sendJson(res, 500, { error: 'Server error: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`HireReady AI backend running at http://localhost:${PORT}`);
  console.log(`Storage: ${usingSqlite ? 'SQLite (' + DB_PATH + ')' : 'JSON file (' + JSON_FALLBACK_PATH + ')'}`);
});
