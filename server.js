/**
 * Aegis OS — hosted server
 *
 * Serves the OS frontend and backs it with real infrastructure:
 *   - /api/fs/*   real files on disk under ./userfiles
 *   - /api/kv/*   small JSON-file key/value store for settings and terminal
 *                 history (replaces the browser storage APIs the artifact
 *                 version had to use instead)
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
const CHAT_FILE = path.join(__dirname, 'data', 'chat.json');
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
      Music: { type: 'folder', children: {} },
      Projects: { type: 'folder', children: { 'notes.txt': { type: 'file', content: 'Project notes go here.\n' } } },
      Assets: { type: 'folder', children: {} },
      Backups: { type: 'folder', children: {} },
      'Recycle Bin': { type: 'folder', children: {} },
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
  if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, '[]\n');
  const primaryHome = path.join(USERFILES_DIR, 'aledeaux');
  if (!fs.existsSync(primaryHome)) {
    fs.mkdirSync(primaryHome, { recursive: true });
    for (const entry of fs.readdirSync(USERFILES_DIR)) {
      if (entry !== 'aledeaux') fs.renameSync(path.join(USERFILES_DIR, entry), path.join(primaryHome, entry));
    }
  }
  // back-fill folders for any user home that predates them
  for (const user of loadUsers()) {
    fs.mkdirSync(path.join(userHome(user), 'Music'), { recursive: true });
    fs.mkdirSync(path.join(userHome(user), 'Recycle Bin'), { recursive: true });
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
  return { id: user.id, username: user.username, role: user.role, active: user.active !== false, createdAt: user.createdAt };
}

// Re-checks the session against the live user record on every request (rather
// than trusting the snapshot taken at login) so a deactivation or role change
// takes effect immediately instead of only at the next sign-in.
function currentUser(req) {
  const token = req.headers.cookie && req.headers.cookie.match(/(?:^|; )aegis_session=([^;]+)/)?.[1];
  if (!token || !sessions.has(token)) return null;
  const liveUser = loadUsers().find(u => u.id === sessions.get(token).id);
  if (!liveUser || liveUser.active === false) { sessions.delete(token); return null; }
  return publicUser(liveUser);
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

// Extensions whose bytes are not valid UTF-8 text (or aren't meant to be
// edited as text) — the JSON tree can't round-trip these as a string
// without mangling them, so they're tracked but never read/rewritten as
// text content.
const BINARY_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'mp4']);
function isBinaryName(name) {
  const ext = String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return BINARY_EXTENSIONS.has(ext);
}

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
    } else if (isBinaryName(entry.name)) {
      // real bytes only ever travel through /api/fs/upload + /api/fs/download —
      // the tree just carries a placeholder so it knows the file exists.
      node.children[entry.name] = { type: 'file', binary: true, content: '' };
    } else {
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (e) {
        /* unreadable (permissions, etc.) — represent as empty */
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

// Syncs disk to match the tree: removes entries no longer present, writes
// text file content, and creates (but never overwrites) binary files —
// their real bytes come from /api/fs/upload, not from this JSON tree.
function writeChildrenToDisk(node, dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const desired = node.children || {};
  const desiredNames = new Set(Object.keys(desired).map(safeName));
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) { /* nothing there yet */ }
  for (const entry of onDisk) {
    if (entry.name.startsWith('.')) continue;
    if (!desiredNames.has(entry.name)) fs.rmSync(path.join(dirPath, entry.name), { recursive: true, force: true });
  }
  for (const [name, child] of Object.entries(desired)) {
    const fullPath = path.join(dirPath, safeName(name));
    if (child && child.type === 'folder') {
      writeChildrenToDisk(child, fullPath);
    } else if (child && child.binary) {
      if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, Buffer.alloc(0));
    } else {
      fs.writeFileSync(fullPath, (child && child.content) || '');
    }
  }
}

function writeTreeToDisk(node, dirPath) {
  writeChildrenToDisk(node, dirPath);
}

ensureDirs();

// /proxy forwards requests (including POST bodies of any content-type) to
// arbitrary upstream sites, so it needs the raw, unparsed body rather than
// JSON-only parsing — give it its own body handling and keep the global
// JSON parser for everything else.
app.use((req, res, next) => {
  if (req.path === '/proxy') return next();
  express.json({ limit: '20mb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- authentication and user management ---------------- */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = loadUsers().find(candidate => candidate.username === String(username || ''));
  if (!user || !passwordMatches(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid username or password' });
  if (user.active === false) return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
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

function setupRequired() {
  try {
    const saved = JSON.parse(fs.readFileSync(kvPath('needs_setup'), 'utf8'));
    const value = saved && typeof saved === 'object' ? saved.value : saved;
    return value !== 'false' && value !== false;
  } catch (e) { return true; }
}

app.get('/api/setup/status', (req, res) => res.json({ needs_setup: setupRequired() }));

app.post('/api/setup/complete', (req, res) => {
  if (!setupRequired()) return res.status(409).json({ error: 'System setup is already complete' });
  const { username, password, timezone, telemetry, settings } = req.body || {};
  const cleanName = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(cleanName) || String(password || '').length < 6) return res.status(400).json({ error: 'Create an admin username and a password of at least 6 characters' });
  const users = loadUsers();
  const existing = users.find(user => user.username.toLowerCase() === cleanName.toLowerCase());
  if (existing) {
    existing.username = cleanName;
    existing.passwordHash = hashPassword(password);
    existing.role = 'superuser';
  } else {
    users.push({ id: crypto.randomUUID(), username: cleanName, passwordHash: hashPassword(password), role: 'superuser', createdAt: new Date().toISOString() });
  }
  saveUsers(users);
  fs.writeFileSync(kvPath('needs_setup'), 'false');
  fs.writeFileSync(kvPath('system-setup'), JSON.stringify({ timezone: timezone || 'UTC', telemetry: telemetry !== false, settings: settings || {} }));
  recordActivity('system-setup', cleanName, 'initial installation complete');
  res.json({ ok: true });
});

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
  const { username, password, role, active } = req.body || {};
  if (username !== undefined && !/^[a-zA-Z0-9._-]{2,32}$/.test(String(username).trim())) return res.status(400).json({ error: 'Invalid username' });
  if (user.username === 'aledeaux' && username !== undefined && String(username).trim() !== 'aledeaux') return res.status(400).json({ error: 'The primary superuser username cannot be changed' });
  if (username !== undefined && users.some(candidate => candidate.id !== user.id && candidate.username.toLowerCase() === String(username).trim().toLowerCase())) return res.status(409).json({ error: 'Username already exists' });
  if (password !== undefined && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role !== undefined && !['user', 'superuser'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (active !== undefined) {
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'Invalid active value' });
    if (active === false && user.username === 'aledeaux') return res.status(400).json({ error: 'The primary superuser cannot be deactivated' });
    if (active === false && user.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  if (username !== undefined) user.username = String(username).trim();
  if (password !== undefined && password !== '') user.passwordHash = hashPassword(password);
  if (role !== undefined) user.role = role;
  if (active !== undefined) user.active = active;
  saveUsers(users);
  if (active === false) {
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token);
    recordActivity('user-deactivated', req.user.username, user.username);
  } else if (active === true) {
    recordActivity('user-activated', req.user.username, user.username);
  } else {
    recordActivity('user-updated', req.user.username, user.username);
  }
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

/* ---------------- chat ---------------- */
/* Direct messages between users, stored as one flat JSON list under        */
/* ./data/chat.json — each message tagged with a sorted "conversation" key  */
/* so a pair of usernames always maps to the same thread regardless of who  */
/* sent the most recent message.                                            */

function readChat() {
  try { return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch (e) { return []; }
}

function saveChat(messages) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(messages.slice(-5000), null, 2) + '\n');
}

function conversationKey(a, b) {
  return [a, b].sort().join('::');
}

app.get('/api/chat/contacts', requireAuth, (req, res) => {
  const contacts = loadUsers()
    .filter(user => user.id !== req.user.id)
    .map(user => ({ id: user.id, username: user.username, active: user.active !== false }));
  res.json({ contacts });
});

app.get('/api/chat/messages', requireAuth, (req, res) => {
  const other = loadUsers().find(user => user.username === String(req.query.with || ''));
  if (!other) return res.status(404).json({ error: 'User not found' });
  const key = conversationKey(req.user.username, other.username);
  let messages = readChat().filter(message => message.conversation === key);
  if (req.query.since) messages = messages.filter(message => message.at > String(req.query.since));
  res.json({ messages: messages.slice(-200) });
});

app.post('/api/chat/messages', requireAuth, (req, res) => {
  const { to, text } = req.body || {};
  const recipient = loadUsers().find(user => user.username === String(to || ''));
  if (!recipient) return res.status(404).json({ error: 'User not found' });
  if (recipient.id === req.user.id) return res.status(400).json({ error: "You can't message yourself" });
  if (recipient.active === false) return res.status(400).json({ error: 'That user is deactivated' });
  const cleanText = String(text || '').trim();
  if (!cleanText) return res.status(400).json({ error: 'Message is empty' });
  if (cleanText.length > 4000) return res.status(400).json({ error: 'Message is too long' });
  const message = {
    id: crypto.randomUUID(),
    conversation: conversationKey(req.user.username, recipient.username),
    from: req.user.username,
    to: recipient.username,
    text: cleanText,
    at: new Date().toISOString()
  };
  const messages = readChat();
  messages.push(message);
  saveChat(messages);
  recordActivity('chat-message', req.user.username, 'to ' + recipient.username);
  res.status(201).json({ message });
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

// Serves a file's real bytes (tree content is read as utf-8 and mangles binary,
// so playback/downloads need the file straight off disk instead).
app.get('/api/fs/download', requireAuth, (req, res) => {
  const relativeDirectory = String(req.query.dir || '').split('/').map(safeName).filter(Boolean);
  const cleanName = safeName(String(req.query.name || '').trim());
  if (!cleanName) return res.status(400).json({ error: 'Missing file name' });
  const target = path.join(userHome(req.user), ...relativeDirectory, cleanName);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'File not found' });
  res.sendFile(target);
});

function resolveEntryPath(user, dirArray, name) {
  const relativeDirectory = (Array.isArray(dirArray) ? dirArray : []).slice(0, 20).map(safeName).filter(Boolean);
  const cleanName = safeName(String(name || '').trim());
  if (!cleanName) return null;
  return { dir: path.join(userHome(user), ...relativeDirectory), name: cleanName, full: path.join(userHome(user), ...relativeDirectory, cleanName) };
}

// Real move/rename on disk — the whole-tree PUT to /api/fs/tree can't safely
// relocate a binary file (mp3, image, …) since it never carries real bytes,
// only a placeholder; a plain tree edit would delete the old copy and create
// an empty file at the new path. Drag-and-drop, cut/paste, rename, and the
// Recycle Bin all route binary moves through here instead.
app.post('/api/fs/move', requireAuth, (req, res) => {
  const { fromDir, fromName, toDir, toName } = req.body || {};
  const source = resolveEntryPath(req.user, fromDir, fromName);
  const dest = resolveEntryPath(req.user, toDir, toName || fromName);
  if (!source || !dest) return res.status(400).json({ error: 'Missing file name' });
  if (!fs.existsSync(source.full)) return res.status(404).json({ error: 'Source not found' });
  try {
    fs.mkdirSync(dest.dir, { recursive: true });
    fs.renameSync(source.full, dest.full);
    recordActivity('file-move', req.user.username, source.name + ' -> ' + dest.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Move failed: ' + e.message }); }
});

// Real byte-for-byte duplicate on disk, for the same reason /api/fs/move
// exists — copying a binary node through the tree would just create an
// empty file at the destination.
app.post('/api/fs/copy', requireAuth, (req, res) => {
  const { fromDir, fromName, toDir, toName } = req.body || {};
  const source = resolveEntryPath(req.user, fromDir, fromName);
  const dest = resolveEntryPath(req.user, toDir, toName || fromName);
  if (!source || !dest) return res.status(400).json({ error: 'Missing file name' });
  if (!fs.existsSync(source.full)) return res.status(404).json({ error: 'Source not found' });
  try {
    fs.mkdirSync(dest.dir, { recursive: true });
    fs.copyFileSync(source.full, dest.full);
    recordActivity('file-copy', req.user.username, source.name + ' -> ' + dest.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Copy failed: ' + e.message }); }
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
/*                                                                              */
/* A plain <base> tag (the original approach) is enough for *static* assets —  */
/* images, CSS, plain <script src> — to resolve and load straight from the     */
/* real site. It is not enough to keep browsing inside the proxy: clicking a   */
/* link or submitting a form would navigate straight to the real site (hitting */
/* its X-Frame-Options again), and any fetch()/XHR the page makes would be a   */
/* genuine cross-origin request the target's CORS policy almost never allows.  */
/* So on top of the <base> tag this rewrites navigation-causing attributes     */
/* (<a href>, <form action>, <iframe src>, <area href>) to route back through  */
/* /proxy, and injects a small shim that redirects the page's own fetch/XHR    */
/* calls through /proxy too — the same rewriting-proxy approach tools like     */
/* Ultraviolet use, just hand-rolled and far simpler (no service worker, no    */
/* WebSocket tunneling).                                                       */

function proxyAbsoluteUrl(url, base) {
  try { return new URL(url, base).href; } catch (e) { return null; }
}

// A root-relative "/proxy?..." URL would itself resolve against the <base>
// tag this response sets (needed so plain assets load from the real site),
// landing back on the *target* site's origin instead of ours — so every
// rewritten link/action needs to be a fully-qualified URL against our own
// origin instead.
function proxyUrlFor(absoluteUrl, ourOrigin) {
  return ourOrigin + '/proxy?url=' + encodeURIComponent(absoluteUrl);
}

// Rewrites the attribute that causes *navigation* on a small set of tags, so
// following it keeps the browser inside /proxy instead of jumping straight to
// the real site (and straight into its X-Frame-Options).
function rewriteNavigationAttr(html, tag, attr, baseUrl, ourOrigin) {
  const re = new RegExp('(<' + tag + '\\b[^>]*?\\s' + attr + '\\s*=\\s*)(["\'])(.*?)\\2', 'gi');
  return html.replace(re, (whole, pre, quote, url) => {
    if (!url || /^(javascript:|mailto:|tel:|#|data:|blob:)/i.test(url)) return whole;
    const abs = proxyAbsoluteUrl(url, baseUrl);
    return abs ? pre + quote + proxyUrlFor(abs, ourOrigin) + quote : whole;
  });
}

function buildProxyInjection(targetUrl) {
  const baseHref = targetUrl.replace(/"/g, '&quot;');
  const baseJson = JSON.stringify(targetUrl);
  return '<base href="' + baseHref + '">\n' +
    '<script>(function(){\n' +
    '  var uvBase = ' + baseJson + ';\n' +
    '  function resolve(u){ try { return new URL(u, uvBase).href; } catch(e){ return u; } }\n' +
    '  function toProxy(u){\n' +
    '    if(typeof u !== "string" || /^(javascript:|data:|blob:|mailto:|tel:|#)/i.test(u)) return u;\n' +
    // location.origin (not a relative path) — a relative "/proxy?..." string
    // would itself get resolved against the <base> tag above and end up
    // pointed at the *target* site's origin instead of ours.
    '    return location.origin + "/proxy?url=" + encodeURIComponent(resolve(u));\n' +
    '  }\n' +
    '  var origFetch = window.fetch;\n' +
    '  if(origFetch){\n' +
    '    window.fetch = function(input, init){\n' +
    '      try{\n' +
    '        if(typeof input === "string") input = toProxy(input);\n' +
    '        else if(input && typeof input.url === "string") input = new Request(toProxy(input.url), input);\n' +
    '      }catch(e){}\n' +
    '      return origFetch.call(this, input, init);\n' +
    '    };\n' +
    '  }\n' +
    '  var origOpen = XMLHttpRequest.prototype.open;\n' +
    '  XMLHttpRequest.prototype.open = function(method, url){\n' +
    '    try{ arguments[1] = toProxy(url); }catch(e){}\n' +
    '    return origOpen.apply(this, arguments);\n' +
    '  };\n' +
    '})();</script>\n';
}

app.all('/proxy', requireAuth, express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(String(target))) {
    return res.status(400).send('Missing or invalid "url" query parameter.');
  }
  const method = req.method.toUpperCase();
  const hasBody = !['GET', 'HEAD'].includes(method) && Buffer.isBuffer(req.body) && req.body.length > 0;
  try {
    const upstream = await fetch(target, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AegisOSProxy/1.0)',
        ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {})
      },
      body: hasBody ? req.body : undefined,
      redirect: 'follow'
    });
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    res.set('Content-Type', contentType);
    // Deliberately not forwarding the upstream's X-Frame-Options / CSP —
    // stripping those is the entire point of this route.

    if (contentType.includes('text/html')) {
      const ourOrigin = req.protocol + '://' + req.get('host');
      let html = buffer.toString('utf-8');
      html = rewriteNavigationAttr(html, 'a', 'href', target, ourOrigin);
      html = rewriteNavigationAttr(html, 'area', 'href', target, ourOrigin);
      html = rewriteNavigationAttr(html, 'iframe', 'src', target, ourOrigin);
      // a <form> with no action submits to the current page — give it an
      // explicit one first so the action-rewrite below has something to catch
      html = html.replace(/<form(?![^>]*\baction\s*=)([^>]*)>/gi, (m, attrs) => '<form' + attrs + ' action="' + target.replace(/"/g, '&quot;') + '">');
      html = rewriteNavigationAttr(html, 'form', 'action', target, ourOrigin);
      const injection = buildProxyInjection(target);
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => m + injection)
        : injection + html;
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
