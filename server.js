/**
 * Aegis OS — hosted server
 *
 * Serves the OS frontend and backs it with real infrastructure:
 *   - /api/fs/*   real files on disk under ./userfiles
 *   - /api/kv/*   small JSON-file key/value store for settings, terminal
 *                 history, and custom music links (replaces the browser
 *                 storage APIs the artifact version had to use instead)
 *   - /proxy      a real server-side proxy for the Browser app
 *
 * User accounts and cookie sessions protect the hosted OS APIs.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const USERFILES_DIR = path.join(__dirname, 'userfiles');
const KV_DIR = path.join(__dirname, 'data', 'kv');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const ACTIVITY_FILE = path.join(__dirname, 'data', 'activity.json');
const sessions = new Map();
const startedAt = Date.now();

/* ---------------- default starter filesystem ---------------- */

function defaultTree() {
  return {
    type: 'folder',
    children: {
      Desktop: { type: 'folder', children: {} },
      Documents: {
        type: 'folder',
        children: {
          'todo.txt': { type: 'file', content: '- Try the terminal\n- Open Settings\n- Have fun\n' },
          'readme.md': {
            type: 'file',
            content:
              '# Aegis OS\n\nThis is the hosted build. Everything in here is a real file on disk under ' +
              '`./userfiles` on the server — edit it in Files, in the Terminal, or directly in your editor, ' +
              'and it shows up in both places.\n'
          }
        }
      },
      Downloads: { type: 'folder', children: { 'build.zip': { type: 'file', content: '' } } },
      Pictures: { type: 'folder', children: { 'wallpaper.png': { type: 'file', content: '' } } },
      Projects: { type: 'folder', children: { 'notes.txt': { type: 'file', content: 'Project notes go here.\n' } } },
      Assets: { type: 'folder', children: {} },
      Backups: { type: 'folder', children: {} },
      userfiles: { type: 'folder', children: {} }
    }
  };
}

function ensureDirs() {
  fs.mkdirSync(USERFILES_DIR, { recursive: true });
  fs.mkdirSync(KV_DIR, { recursive: true });
  if (fs.readdirSync(USERFILES_DIR).length === 0) {
    writeTreeToDisk(defaultTree(), USERFILES_DIR);
  }
  if (!fs.existsSync(USERS_FILE)) {
    saveUsers([{ id: crypto.randomUUID(), username: 'aledeaux', passwordHash: hashPassword('passwood'), role: 'superuser', createdAt: new Date().toISOString() }]);
  }
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]\n');
  const primaryHome = path.join(USERFILES_DIR, 'aledeaux');
  if (!fs.existsSync(primaryHome)) {
    fs.mkdirSync(primaryHome, { recursive: true });
    for (const entry of fs.readdirSync(USERFILES_DIR)) {
      if (entry !== 'aledeaux') fs.renameSync(path.join(USERFILES_DIR, entry), path.join(primaryHome, entry));
    }
  }
}

function recordActivity(type, username, detail = '') {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch (e) { /* recreate below */ }
  entries.push({ id: crypto.randomUUID(), type, username: username || 'system', detail, at: new Date().toISOString() });
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(entries.slice(-200), null, 2) + '\n');
}

function readActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch (e) { return []; }
}

function userHome(user) {
  const home = path.join(USERFILES_DIR, user.username);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function passwordMatches(password, stored) {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex'));
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n');
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

function currentUser(req) {
  const token = req.headers.cookie && req.headers.cookie.match(/(?:^|; )aegis_session=([^;]+)/)?.[1];
  return token ? sessions.get(token) : null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

function requireSuperuser(req, res, next) {
  if (req.user.role !== 'superuser') return res.status(403).json({ error: 'Superuser access required' });
  next();
}

/* ---------------- tree <-> real files on disk ---------------- */

function readTreeFromDisk(dirPath) {
  const node = { type: 'folder', children: {} };
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return node;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      node.children[entry.name] = readTreeFromDisk(fullPath);
    } else {
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (e) {
        /* unreadable (binary, permissions, etc.) — represent as empty */
      }
      node.children[entry.name] = { type: 'file', content };
    }
  }
  return node;
}

function safeName(name) {
  // keep this to simple filenames — no path traversal, no separators
  return String(name).replace(/[\/\\]/g, '_').replace(/^\.+/, '_');
}

function writeChildrenToDisk(node, dirPath) {
  for (const [name, child] of Object.entries(node.children || {})) {
    const fullPath = path.join(dirPath, safeName(name));
    if (child && child.type === 'folder') {
      fs.mkdirSync(fullPath, { recursive: true });
      writeChildrenToDisk(child, fullPath);
    } else {
      fs.writeFileSync(fullPath, (child && child.content) || '');
    }
  }
}

function writeTreeToDisk(node, dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
  writeChildrenToDisk(node, dirPath);
}

ensureDirs();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- authentication and user management ---------------- */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = loadUsers().find(candidate => candidate.username === String(username || ''));
  if (!user || !passwordMatches(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, publicUser(user));
  recordActivity('login', user.username);
  res.setHeader('Set-Cookie', `aegis_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.cookie && req.headers.cookie.match(/(?:^|; )aegis_session=([^;]+)/)?.[1];
  const sessionUser = token && sessions.get(token);
  if (token) sessions.delete(token);
  if (sessionUser) recordActivity('logout', sessionUser.username);
  res.setHeader('Set-Cookie', 'aegis_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!passwordMatches(currentPassword, loadUsers().find(user => user.id === req.user.id)?.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = loadUsers();
  const user = users.find(candidate => candidate.id === req.user.id);
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  recordActivity('password-change', user.username);
  res.json({ user: publicUser(user) });
});

app.get('/api/users', requireAuth, requireSuperuser, (req, res) => res.json({ users: loadUsers().map(publicUser) }));

app.post('/api/users', requireAuth, requireSuperuser, (req, res) => {
  const { username, password, role = 'user' } = req.body || {};
  const cleanName = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(cleanName) || String(password || '').length < 6) return res.status(400).json({ error: 'Use a valid username and a password of at least 6 characters' });
  if (!['user', 'superuser'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const users = loadUsers();
  if (users.some(user => user.username.toLowerCase() === cleanName.toLowerCase())) return res.status(409).json({ error: 'Username already exists' });
  const user = { id: crypto.randomUUID(), username: cleanName, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString() };
  users.push(user); saveUsers(users);
  recordActivity('user-created', req.user.username, cleanName);
  res.status(201).json({ user: publicUser(user) });
});

app.put('/api/users/:id', requireAuth, requireSuperuser, (req, res) => {
  const users = loadUsers();
  const user = users.find(candidate => candidate.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { username, password, role } = req.body || {};
  if (username !== undefined && !/^[a-zA-Z0-9._-]{2,32}$/.test(String(username).trim())) return res.status(400).json({ error: 'Invalid username' });
  if (user.username === 'aledeaux' && username !== undefined && String(username).trim() !== 'aledeaux') return res.status(400).json({ error: 'The primary superuser username cannot be changed' });
  if (username !== undefined && users.some(candidate => candidate.id !== user.id && candidate.username.toLowerCase() === String(username).trim().toLowerCase())) return res.status(409).json({ error: 'Username already exists' });
  if (password !== undefined && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role !== undefined && !['user', 'superuser'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (username !== undefined) user.username = String(username).trim();
  if (password !== undefined && password !== '') user.passwordHash = hashPassword(password);
  if (role !== undefined) user.role = role;
  saveUsers(users);
  recordActivity('user-updated', req.user.username, user.username);
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', requireAuth, requireSuperuser, (req, res) => {
  const users = loadUsers();
  const user = users.find(candidate => candidate.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id || user.username === 'aledeaux') return res.status(400).json({ error: 'The primary superuser cannot be removed' });
  saveUsers(users.filter(candidate => candidate.id !== user.id));
  fs.rmSync(path.join(USERFILES_DIR, user.username), { recursive: true, force: true });
  recordActivity('user-removed', req.user.username, user.username);
  res.json({ deleted: true });
});

app.post('/api/system/reset', (req, res) => {
  const { username, password } = req.body || {};
  const admin = loadUsers().find(user => user.username === String(username || '') && user.role === 'superuser');
  if (!admin || !passwordMatches(password, admin.passwordHash)) return res.status(403).json({ error: 'Valid superuser credentials are required' });
  try {
    for (const entry of fs.readdirSync(USERFILES_DIR)) fs.rmSync(path.join(USERFILES_DIR, entry), { recursive: true, force: true });
    for (const file of fs.readdirSync(KV_DIR)) fs.rmSync(path.join(KV_DIR, file), { force: true });
    for (const user of loadUsers()) writeTreeToDisk(defaultTree(), userHome(user));
    recordActivity('system-reset', admin.username, 'all user homes and persisted data');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'System reset failed: ' + e.message });
  }
});

/* ---------------- real filesystem API ---------------- */

app.use('/api/fs', requireAuth);
app.use('/api/kv', requireAuth);

app.post('/api/fs/upload', requireAuth, (req, res) => {
  const { name, data, directory = [] } = req.body || {};
  const cleanName = safeName(String(name || '').trim());
  if (!cleanName || cleanName === '.' || cleanName.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'ZIP files are not allowed' });
  if (typeof data !== 'string' || data.length > 30 * 1024 * 1024) return res.status(400).json({ error: 'Invalid or oversized upload' });
  try {
    const relativeDirectory = Array.isArray(directory) ? directory.slice(0, 20).map(safeName).filter(Boolean) : [];
    const targetDirectory = path.join(userHome(req.user), ...relativeDirectory);
    fs.mkdirSync(targetDirectory, { recursive: true });
    const target = path.join(targetDirectory, cleanName);
    fs.writeFileSync(target, Buffer.from(data, 'base64'));
    recordActivity('file-upload', req.user.username, cleanName);
    res.status(201).json({ ok: true, name: cleanName });
  } catch (e) { res.status(500).json({ error: 'Upload failed: ' + e.message }); }
});

app.get('/api/system/status', requireAuth, (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    memory: { used: memory.rss, heap: memory.heapUsed, total: memory.heapTotal },
    cpuCount: require('os').cpus().length,
    platform: process.platform,
    node: process.version,
    activeSessions: sessions.size
  });
});

app.get('/api/activity', requireAuth, requireSuperuser, (req, res) => {
  res.json({ entries: readActivity().slice(-50).reverse() });
});

app.get('/api/fs/tree', (req, res) => {
  res.json(readTreeFromDisk(userHome(req.user)));
});

app.put('/api/fs/tree', (req, res) => {
  try {
    writeTreeToDisk(req.body, userHome(req.user));
    recordActivity('filesystem-save', req.user.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/reset', (req, res) => {
  try {
    writeTreeToDisk(defaultTree(), userHome(req.user));
    recordActivity('filesystem-reset', req.user.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- generic key/value store ---------------- */
/* settings, terminal history, custom music links — small JSON blobs,   */
/* not user-facing "files", so these live under ./data/kv instead of    */
/* mixing into the real userfiles tree.                                 */

function kvPath(key) {
  const safe = Buffer.from(String(key)).toString('base64url');
  return path.join(KV_DIR, safe + '.json');
}

app.get('/api/kv/:key', (req, res) => {
  const file = kvPath(req.params.key);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  const value = fs.readFileSync(file, 'utf-8');
  res.json({ key: req.params.key, value });
});

app.put('/api/kv/:key', (req, res) => {
  try {
    fs.writeFileSync(kvPath(req.params.key), req.body && req.body.value != null ? req.body.value : '');
    res.json({ key: req.params.key, value: req.body.value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/kv/:key', (req, res) => {
  const file = kvPath(req.params.key);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ deleted: true });
});

/* ---------------- real server-side proxy for the Browser app ---------------- */
/* Fetches the target server-side and serves it back same-origin, which is     */
/* what actually gets around X-Frame-Options — the browser only ever checks    */
/* headers on the response it received (ours), not the original site's.       */
/* An injected <base> tag makes relative-path CSS/JS/images resolve against    */
/* the real site and load directly from it, not through this proxy.            */

app.get('/proxy', requireAuth, async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(String(target))) {
    return res.status(400).send('Missing or invalid "url" query parameter.');
  }
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AegisOSProxy/1.0)' },
      redirect: 'follow'
    });
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    res.set('Content-Type', contentType);
    // Deliberately not forwarding the upstream's X-Frame-Options / CSP —
    // stripping those is the entire point of this route.

    if (contentType.includes('text/html')) {
      let html = buffer.toString('utf-8');
      const baseTag = '<base href="' + target.replace(/"/g, '&quot;') + '">';
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => m + baseTag)
        : baseTag + html;
      return res.send(html);
    }
    res.send(buffer);
  } catch (err) {
    res.status(502).send('Proxy fetch failed: ' + err.message);
  }
});

/* ---------------- SPA fallback ---------------- */

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Aegis OS running at http://localhost:' + PORT);
});
