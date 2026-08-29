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
const BANK_FILE = path.join(__dirname, 'data', 'bank.json');
const sessions = new Map();
const startedAt = Date.now();
const STARTING_BALANCE = 2500;

// In-memory only — a breach is a live "you're currently inside their
// system" session, not a fact worth persisting across a server restart.
// Keyed by attacker user id.
const activeBreaches = new Map();
const exploitCooldowns = new Map();

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
  if (!fs.existsSync(USERS_FILE)) saveUsers([]);
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]\n');
  if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, '[]\n');
  if (!fs.existsSync(BANK_FILE)) fs.writeFileSync(BANK_FILE, '[]\n');
  ensureEconomyFields(loadUsers());
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

/* ---------------- malware catalog ---------------- */
/* A static reference list — "viruses, trojans, and other malware" a player  */
/* can buy and deploy against a breached target. `mechanic` is one of a      */
/* handful of reusable effects (see applyMalwareEffect below); several       */
/* entries deliberately share a mechanic at different price/tier points so   */
/* the catalog reads like a real toolkit instead of one-off special cases.   */

const MALWARE_CATALOG = [
  { id: 'nightcrawler', name: 'Nightcrawler', category: 'virus', tier: 1, cost: 120, mechanic: 'drain', effect: 'Burns 10-18% of the target\'s balance on install.', description: 'A blunt, self-replicating virus that corrupts loose change in the target\'s account the moment it lands.' },
  { id: 'sepulcher', name: 'Sepulcher', category: 'virus', tier: 3, cost: 550, mechanic: 'drain', effect: 'Burns 30-45% of the target\'s balance on install.', description: 'A destructive wiper virus. Expensive, and it announces itself — but it does real damage on contact.' },
  { id: 'blightspread', name: 'Blightspread', category: 'worm', tier: 1, cost: 150, mechanic: 'drain', effect: 'Burns 6-10% of the target\'s balance on install.', description: 'A worm that eats a little on the way through every account it touches.' },
  { id: 'static', name: 'Static', category: 'worm', tier: 2, cost: 300, mechanic: 'weaken', effect: 'Permanently drops the target\'s firewall by 1 level (until they upgrade).', description: 'Self-propagating noise that grinds down a target\'s firewall configuration until it just... stops holding.' },
  { id: 'wraithdoor', name: 'Wraithdoor', category: 'trojan', tier: 2, cost: 350, mechanic: 'backdoor', effect: 'Future exploit attempts against this target auto-succeed while installed.', description: 'A persistent backdoor trojan disguised as legitimate system software.' },
  { id: 'deadbolt', name: 'Deadbolt', category: 'trojan', tier: 1, cost: 130, mechanic: 'drain', effect: 'Burns 8-14% of the target\'s balance on install.', description: 'A cheap trojan that pockets whatever it can reach before anyone notices.' },
  { id: 'botfly', name: 'Botfly', category: 'botnet', tier: 2, cost: 280, mechanic: 'backdoor', effect: 'Future exploit attempts against this target auto-succeed while installed.', description: 'Conscripts the target\'s machine into a botnet, leaving a standing connection back to you.' },
  { id: 'cryptolock', name: 'Cryptolock', category: 'ransomware', tier: 3, cost: 500, mechanic: 'lockdown', effect: 'Freezes the target\'s outgoing transfers until they pay you or run antivirus.', description: 'Encrypts the target\'s bank account and leaves a ransom note with your name on it.' },
  { id: 'undertow', name: 'Undertow', category: 'ransomware', tier: 2, cost: 380, mechanic: 'lockdown', effect: 'Freezes the target\'s outgoing transfers until they pay you or run antivirus.', description: 'A cheaper, sloppier ransomware kit — still locks the account down just fine.' },
  { id: 'nullroot', name: 'Nullroot', category: 'rootkit', tier: 3, cost: 450, mechanic: 'cloak', effect: 'Hides your future intrusions on this target from their security log.', description: 'Buries itself below the filesystem and quietly edits the target\'s security log on your behalf.' },
  { id: 'hollowman', name: 'Hollowman', category: 'rootkit', tier: 2, cost: 320, mechanic: 'cloak', effect: 'Hides your future intrusions on this target from their security log.', description: 'A lighter-weight rootkit — less thorough than Nullroot, still keeps you off the record.' },
  { id: 'ghostkey', name: 'Ghostkey', category: 'spyware', tier: 2, cost: 300, mechanic: 'monitor', effect: 'Lets you check this target\'s dossier anytime, no re-scan needed.', description: 'A keylogger and session-watcher that phones your dossier updates home.' },
  { id: 'whispernet', name: 'Whispernet', category: 'spyware', tier: 1, cost: 180, mechanic: 'monitor', effect: 'Lets you check this target\'s dossier anytime, no re-scan needed.', description: 'A lighter spyware kit for keeping tabs on a target without paying for Ghostkey.' },
  { id: 'junkstream', name: 'Junkstream', category: 'adware', tier: 1, cost: 60, mechanic: 'nuisance', effect: 'Floods the target with pop-up spam next time they\'re online. Cosmetic.', description: 'Cheap, obnoxious, and mostly harmless — buys you nothing but the satisfaction of annoying someone.' }
];

function malwareById(id) {
  return MALWARE_CATALOG.find(m => m.id === id);
}

/* ---------------- currency & security profile ---------------- */

const PORT_CATALOG = [21, 22, 23, 25, 80, 443, 445, 3306, 3389, 8080];

// The core skill game: three exploit approaches, three purchasable defense
// modules, in a rock-paper-scissors triangle. A module beats one approach
// and loses to another — there is deliberately no "safe" module and no
// "always works" approach, so success comes from reading a target (or
// paying for a deep scan) and picking the right counter, not from outspending
// them on a single generic stat.
const ATTACK_APPROACHES = ['bruteforce', 'stealth', 'injection'];
const DEFENSE_MODULES = ['ratelimiter', 'sentinel', 'decoy'];
// approach -> the module it beats
const APPROACH_BEATS_MODULE = { bruteforce: 'decoy', stealth: 'ratelimiter', injection: 'sentinel' };
// approach -> the module it loses to
const APPROACH_LOSES_TO_MODULE = { bruteforce: 'ratelimiter', stealth: 'sentinel', injection: 'decoy' };
const MODULE_COST = 150;
const DEEPSCAN_COST = 75;
const EXPLOIT_COST = 20;
// Every roll, in either direction, stays inside this band — no purchase or
// module combination ever pushes a matchup to a guaranteed win or loss.
const MIN_CHANCE = 10, MAX_CHANCE = 90;
function clampChance(n) { return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, Math.round(n))); }

// Deterministic per-account "open ports" — stable across scans (so recon
// actually means something) without needing to persist an RNG state.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  return hash;
}
function defaultSecurity(user) {
  const rand = mulberry32(seedFromString(user.id));
  const count = 3 + Math.floor(rand() * 3); // 3-5 open ports
  const pool = PORT_CATALOG.slice();
  const ports = [];
  while (ports.length < count && pool.length) ports.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return { firewall: 1, antivirus: 1, ports: ports.sort((a, b) => a - b), modules: {}, infections: [], log: [], ransom: null };
}

// Back-fills accounts created before the currency/security system existed
// (and normalizes anything missing) — called once at boot and safe to call
// repeatedly since it only fills in gaps.
function ensureEconomyFields(users) {
  let changed = false;
  for (const user of users) {
    if (typeof user.balance !== 'number') { user.balance = STARTING_BALANCE; changed = true; }
    if (!user.security) { user.security = defaultSecurity(user); changed = true; }
    if (user.security && !user.security.modules) { user.security.modules = {}; changed = true; }
  }
  if (changed) saveUsers(users);
  return users;
}

function readBank() {
  try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch (e) { return []; }
}
function saveBank(transactions) {
  fs.writeFileSync(BANK_FILE, JSON.stringify(transactions.slice(-5000), null, 2) + '\n');
}
function recordTransaction(from, to, amount, type, note = '') {
  const transactions = readBank();
  const entry = { id: crypto.randomUUID(), from, to, amount, type, note, at: new Date().toISOString() };
  transactions.push(entry);
  saveBank(transactions);
  return entry;
}

// Persists `users` unconditionally — this is where deploy/steal/exploit
// hand off their in-memory balance and infection mutations to disk, whether
// or not the log entry itself ends up recorded.
function recordSecurityLog(users, targetUser, entry) {
  // A cloak-type infection installed by this same attacker on this same
  // target suppresses the record — that's the entire point of a rootkit.
  const cloaked = (targetUser.security.infections || []).some(inf => {
    const malware = malwareById(inf.malwareId);
    return malware && malware.mechanic === 'cloak' && inf.by === entry.by;
  });
  if (!cloaked || !entry.by) {
    targetUser.security.log = targetUser.security.log || [];
    targetUser.security.log.push({ id: crypto.randomUUID(), ...entry, at: new Date().toISOString() });
    targetUser.security.log = targetUser.security.log.slice(-100);
  }
  saveUsers(users);
}

function publicSecurity(user, { includeSensitive } = {}) {
  const sec = user.security || defaultSecurity(user);
  const base = { firewall: sec.firewall, antivirus: sec.antivirus, ports: sec.ports };
  if (!includeSensitive) return base;
  return {
    ...base,
    modules: sec.modules || {},
    infections: (sec.infections || []).map(inf => ({ ...inf, malware: malwareById(inf.malwareId) })),
    log: (sec.log || []).slice().reverse(),
    ransom: sec.ransom || null,
    pendingAnnoy: sec.pendingAnnoy || 0,
    balance: user.balance
  };
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

// The session cookie is the real credential (HttpOnly, never readable by
// client JS). The second cookie is just a UX signal — "this browser has
// signed in here before" — so the boot flow can default to Sign In instead
// of Sign Up; it carries no secret, so it's deliberately readable client-side.
const KNOWN_DEVICE_COOKIE = 'aegis_known_device';
const KNOWN_DEVICE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, in seconds

function setAuthCookies(res, token) {
  res.setHeader('Set-Cookie', [
    `aegis_session=${token}; HttpOnly; SameSite=Lax; Path=/`,
    `${KNOWN_DEVICE_COOKIE}=1; SameSite=Lax; Path=/; Max-Age=${KNOWN_DEVICE_MAX_AGE}`
  ]);
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = loadUsers().find(candidate => candidate.username === String(username || ''));
  if (!user || !passwordMatches(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid username or password' });
  if (user.active === false) return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, publicUser(user));
  recordActivity('login', user.username);
  setAuthCookies(res, token);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.cookie && req.headers.cookie.match(/(?:^|; )aegis_session=([^;]+)/)?.[1];
  const sessionUser = token && sessions.get(token);
  if (token) sessions.delete(token);
  if (sessionUser) recordActivity('logout', sessionUser.username);
  // the known-device cookie is deliberately left alone on logout — this
  // browser still belongs to someone with an account here, so it should
  // still land back on Sign In, not Sign Up.
  res.setHeader('Set-Cookie', 'aegis_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// Self-service registration — the first account ever created on a fresh
// instance becomes the superuser, everyone after that is a regular user.
app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body || {};
  const cleanName = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(cleanName) || String(password || '').length < 6) return res.status(400).json({ error: 'Choose a username and a password of at least 6 characters' });
  const users = loadUsers();
  if (users.some(user => user.username.toLowerCase() === cleanName.toLowerCase())) return res.status(409).json({ error: 'That username is taken' });
  const role = users.length === 0 ? 'superuser' : 'user';
  const user = { id: crypto.randomUUID(), username: cleanName, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString(), balance: STARTING_BALANCE };
  user.security = defaultSecurity(user);
  users.push(user);
  saveUsers(users);
  recordActivity('signup', cleanName, role === 'superuser' ? 'first account — superuser' : '');
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, publicUser(user));
  setAuthCookies(res, token);
  res.status(201).json({ user: publicUser(user) });
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
  const user = { id: crypto.randomUUID(), username: cleanName, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString(), balance: STARTING_BALANCE };
  user.security = defaultSecurity(user);
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
  if (username !== undefined && users.some(candidate => candidate.id !== user.id && candidate.username.toLowerCase() === String(username).trim().toLowerCase())) return res.status(409).json({ error: 'Username already exists' });
  if (password !== undefined && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role !== undefined && !['user', 'superuser'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (active !== undefined) {
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'Invalid active value' });
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
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
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

/* ---------------- bank / currency ---------------- */

app.get('/api/bank/account', requireAuth, (req, res) => {
  const user = loadUsers().find(candidate => candidate.id === req.user.id);
  const transactions = readBank().filter(t => t.from === user.username || t.to === user.username).slice(-50).reverse();
  res.json({ balance: user.balance, ransom: (user.security && user.security.ransom) || null, transactions });
});

app.post('/api/bank/transfer', requireAuth, (req, res) => {
  const { to, amount, note } = req.body || {};
  const cleanAmount = Math.floor(Number(amount));
  const users = loadUsers();
  const sender = users.find(candidate => candidate.id === req.user.id);
  const recipient = users.find(candidate => candidate.username === String(to || ''));
  if (!recipient) return res.status(404).json({ error: 'User not found' });
  if (recipient.id === sender.id) return res.status(400).json({ error: "You can't transfer to yourself" });
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
  if (sender.security && sender.security.ransom) return res.status(403).json({ error: 'Your account is locked by ransomware — pay it or run antivirus first' });
  if (sender.balance < cleanAmount) return res.status(400).json({ error: 'Insufficient balance' });
  sender.balance -= cleanAmount;
  recipient.balance += cleanAmount;
  saveUsers(users);
  const entry = recordTransaction(sender.username, recipient.username, cleanAmount, 'transfer', String(note || '').slice(0, 200));
  recordActivity('bank-transfer', sender.username, 'to ' + recipient.username + ' — $' + cleanAmount);
  res.status(201).json({ transaction: entry, balance: sender.balance });
});

app.post('/api/bank/pay-ransom', requireAuth, (req, res) => {
  const users = loadUsers();
  const victim = users.find(candidate => candidate.id === req.user.id);
  const ransom = victim.security && victim.security.ransom;
  if (!ransom) return res.status(400).json({ error: 'No active ransom on this account' });
  const attacker = users.find(candidate => candidate.username === ransom.by);
  if (victim.balance < ransom.amount) return res.status(400).json({ error: "You can't afford the ransom — try antivirus instead" });
  victim.balance -= ransom.amount;
  if (attacker) attacker.balance += ransom.amount;
  victim.security.infections = (victim.security.infections || []).filter(inf => inf.id !== ransom.infectionId);
  victim.security.ransom = null;
  saveUsers(users);
  recordTransaction(victim.username, ransom.by, ransom.amount, 'ransom');
  recordActivity('ransom-paid', victim.username, 'to ' + ransom.by + ' — $' + ransom.amount);
  res.json({ ok: true, balance: victim.balance });
});

/* ---------------- cybersecurity & hacking ---------------- */

app.get('/api/hack/targets', requireAuth, (req, res) => {
  const targets = loadUsers()
    .filter(user => user.id !== req.user.id && user.active !== false)
    .map(user => ({ username: user.username }));
  res.json({ targets });
});

app.get('/api/hack/malware', requireAuth, (req, res) => {
  res.json({ malware: MALWARE_CATALOG });
});

app.get('/api/hack/status', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const user = users.find(candidate => candidate.id === req.user.id);
  res.json({ security: publicSecurity(user, { includeSensitive: true }) });
});

app.get('/api/hack/scan/:username', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const target = users.find(candidate => candidate.username === req.params.username && candidate.active !== false);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't scan yourself — try secstatus" });
  res.json({ username: target.username, ...publicSecurity(target) });
});

function upgradeCost(level) { return level * 250; }

app.post('/api/hack/firewall/upgrade', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const user = users.find(candidate => candidate.id === req.user.id);
  if (user.security.firewall >= 5) return res.status(400).json({ error: 'Firewall is already at maximum level' });
  const cost = upgradeCost(user.security.firewall);
  if (user.balance < cost) return res.status(400).json({ error: 'Not enough funds — need $' + cost });
  user.balance -= cost;
  user.security.firewall += 1;
  saveUsers(users);
  res.json({ firewall: user.security.firewall, balance: user.balance });
});

app.post('/api/hack/antivirus/upgrade', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const user = users.find(candidate => candidate.id === req.user.id);
  if (user.security.antivirus >= 5) return res.status(400).json({ error: 'Antivirus is already at maximum level' });
  const cost = upgradeCost(user.security.antivirus);
  if (user.balance < cost) return res.status(400).json({ error: 'Not enough funds — need $' + cost });
  user.balance -= cost;
  user.security.antivirus += 1;
  saveUsers(users);
  res.json({ antivirus: user.security.antivirus, balance: user.balance });
});

app.post('/api/hack/secure', requireAuth, (req, res) => {
  const { port, module } = req.body || {};
  const cleanPort = Number(port);
  const users = ensureEconomyFields(loadUsers());
  const user = users.find(candidate => candidate.id === req.user.id);
  if (!user.security.ports.includes(cleanPort)) return res.status(400).json({ error: 'That port is not open on your system — see secstatus' });
  if (!DEFENSE_MODULES.includes(module)) return res.status(400).json({ error: 'Unknown module — choose from ' + DEFENSE_MODULES.join(', ') });
  if (user.balance < MODULE_COST) return res.status(400).json({ error: 'Not enough funds — installing a module costs $' + MODULE_COST });
  user.balance -= MODULE_COST;
  user.security.modules[cleanPort] = module;
  saveUsers(users);
  recordActivity('hack-secure', user.username, module + ' on port ' + cleanPort);
  res.json({ modules: user.security.modules, balance: user.balance });
});

app.get('/api/hack/deepscan/:username', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const viewer = users.find(candidate => candidate.id === req.user.id);
  const target = users.find(candidate => candidate.username === req.params.username && candidate.active !== false);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === viewer.id) return res.status(400).json({ error: "You can't deep-scan yourself — try secstatus" });
  if (viewer.balance < DEEPSCAN_COST) return res.status(400).json({ error: 'Not enough funds — a deep scan costs $' + DEEPSCAN_COST });
  viewer.balance -= DEEPSCAN_COST;
  saveUsers(users);
  res.json({
    username: target.username,
    firewall: target.security.firewall,
    antivirus: target.security.antivirus,
    ports: target.security.ports,
    modules: target.security.ports.reduce((acc, p) => { acc[p] = target.security.modules[p] || null; return acc; }, {})
  });
});

app.post('/api/hack/exploit', requireAuth, (req, res) => {
  const { target: targetName, port, approach } = req.body || {};
  const cleanPort = Number(port);
  const users = ensureEconomyFields(loadUsers());
  const attacker = users.find(candidate => candidate.id === req.user.id);
  const target = users.find(candidate => candidate.username === String(targetName || '') && candidate.active !== false);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === attacker.id) return res.status(400).json({ error: "You can't exploit yourself" });
  if (!target.security.ports.includes(cleanPort)) return res.status(400).json({ error: 'That port is not open on the target — scan them first' });
  if (!ATTACK_APPROACHES.includes(approach)) return res.status(400).json({ error: 'Choose an approach: ' + ATTACK_APPROACHES.join(', ') });
  const lastAttempt = exploitCooldowns.get(attacker.id) || 0;
  if (Date.now() - lastAttempt < 5000) return res.status(429).json({ error: 'Give it a moment before trying again' });
  if (attacker.balance < EXPLOIT_COST) return res.status(400).json({ error: 'Not enough funds — an exploit attempt costs $' + EXPLOIT_COST });
  exploitCooldowns.set(attacker.id, Date.now());
  attacker.balance -= EXPLOIT_COST;

  const hasBackdoor = (target.security.infections || []).some(inf => {
    const malware = malwareById(inf.malwareId);
    return malware && malware.mechanic === 'backdoor' && inf.by === attacker.username;
  });

  let chance;
  if (hasBackdoor) {
    chance = MAX_CHANCE;
  } else {
    const module = target.security.modules[cleanPort];
    let base;
    if (!module) base = 50;
    else if (APPROACH_BEATS_MODULE[approach] === module) base = 78;
    else if (APPROACH_LOSES_TO_MODULE[approach] === module) base = 22;
    else base = 50; // shouldn't happen with only 3 modules, but keep a sane fallback
    chance = clampChance(base + (attacker.security.firewall - target.security.firewall) * 3);
  }
  const success = Math.random() * 100 < chance;

  if (success) {
    activeBreaches.set(attacker.id, { target: target.username, expiresAt: Date.now() + 120000 });
    recordSecurityLog(users, target, { by: attacker.username, action: 'exploit-success' });
    recordActivity('hack-exploit-success', attacker.username, 'vs ' + target.username);
    return res.json({ success: true, chance, breachExpiresIn: 120, balance: attacker.balance });
  }
  recordSecurityLog(users, target, { by: attacker.username, action: 'exploit-failed' });
  recordActivity('hack-exploit-failed', attacker.username, 'vs ' + target.username);
  res.json({ success: false, chance, balance: attacker.balance });
});

function requireActiveBreach(req, res, users) {
  const breach = activeBreaches.get(req.user.id);
  if (!breach || breach.expiresAt < Date.now()) {
    res.status(403).json({ error: 'No active breach — exploit a target first' });
    return null;
  }
  const target = users.find(candidate => candidate.username === breach.target);
  if (!target) {
    res.status(404).json({ error: 'Target no longer exists' });
    return null;
  }
  return target;
}

app.post('/api/hack/steal', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const attacker = users.find(candidate => candidate.id === req.user.id);
  const target = requireActiveBreach(req, res, users);
  if (!target) return;
  const pct = 0.05 + Math.random() * 0.1;
  const amount = Math.floor(target.balance * pct);
  target.balance -= amount;
  attacker.balance += amount;
  activeBreaches.delete(attacker.id);
  if (amount > 0) recordTransaction(target.username, attacker.username, amount, 'theft');
  recordSecurityLog(users, target, { by: attacker.username, action: 'theft', amount });
  recordActivity('hack-steal', attacker.username, 'from ' + target.username + ' — $' + amount);
  res.json({ amount, balance: attacker.balance });
});

app.post('/api/hack/deploy', requireAuth, (req, res) => {
  const { malwareId } = req.body || {};
  const malware = malwareById(String(malwareId || ''));
  if (!malware) return res.status(400).json({ error: 'Unknown malware — check `malware list`' });
  const users = ensureEconomyFields(loadUsers());
  const attacker = users.find(candidate => candidate.id === req.user.id);
  const target = requireActiveBreach(req, res, users);
  if (!target) return;
  if (attacker.balance < malware.cost) return res.status(400).json({ error: 'Not enough funds — ' + malware.name + ' costs $' + malware.cost });
  attacker.balance -= malware.cost;
  const infection = { id: crypto.randomUUID(), malwareId: malware.id, by: attacker.username, at: new Date().toISOString() };
  target.security.infections = target.security.infections || [];
  target.security.infections.push(infection);

  let resultNote = malware.name + ' installed.';
  if (malware.mechanic === 'drain') {
    const pct = 0.06 + Math.random() * (malware.tier * 0.1);
    const amount = Math.floor(target.balance * Math.min(pct, 0.45));
    target.balance -= amount;
    attacker.balance += amount;
    if (amount > 0) recordTransaction(target.username, attacker.username, amount, 'malware:' + malware.id);
    resultNote += ' Drained $' + amount + '.';
  } else if (malware.mechanic === 'weaken') {
    target.security.firewall = Math.max(0, target.security.firewall - 1);
    resultNote += ' Firewall dropped to ' + target.security.firewall + '.';
  } else if (malware.mechanic === 'lockdown') {
    const amount = Math.max(50, Math.floor(target.balance * 0.25));
    target.security.ransom = { amount, by: attacker.username, infectionId: infection.id };
    resultNote += ' Account locked — ransom set to $' + amount + '.';
  } else if (malware.mechanic === 'nuisance') {
    target.security.pendingAnnoy = (target.security.pendingAnnoy || 0) + 1;
  }
  // 'backdoor', 'cloak', and 'monitor' are passive — checked elsewhere
  // (exploit, recordSecurityLog, and dossier lookups respectively) for as
  // long as the infection stays in the target's infections list.

  recordSecurityLog(users, target, { by: attacker.username, action: 'deploy:' + malware.id });
  recordActivity('hack-deploy', attacker.username, malware.name + ' vs ' + target.username);
  res.json({ ok: true, note: resultNote, balance: attacker.balance });
});

app.post('/api/hack/avscan', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const user = users.find(candidate => candidate.id === req.user.id);
  const infections = user.security.infections || [];
  const removed = [];
  const remaining = [];
  for (const inf of infections) {
    const malware = malwareById(inf.malwareId);
    const chance = Math.max(5, Math.min(95, 25 + user.security.antivirus * 15 - (malware ? malware.tier * 10 : 0)));
    if (Math.random() * 100 < chance) {
      removed.push({ ...inf, malware });
      if (user.security.ransom && user.security.ransom.infectionId === inf.id) user.security.ransom = null;
    } else {
      remaining.push(inf);
    }
  }
  user.security.infections = remaining;
  saveUsers(users);
  recordActivity('hack-avscan', user.username, removed.length + ' removed, ' + remaining.length + ' remain');
  res.json({ removed, remaining: remaining.map(inf => ({ ...inf, malware: malwareById(inf.malwareId) })) });
});

app.get('/api/hack/dossier/:username', requireAuth, (req, res) => {
  const users = ensureEconomyFields(loadUsers());
  const viewer = users.find(candidate => candidate.id === req.user.id);
  const target = users.find(candidate => candidate.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const canMonitor = (target.security.infections || []).some(inf => {
    const malware = malwareById(inf.malwareId);
    return malware && malware.mechanic === 'monitor' && inf.by === viewer.username;
  });
  if (!canMonitor) return res.status(403).json({ error: 'No monitoring malware installed on this target' });
  res.json({ username: target.username, balance: target.balance, ...publicSecurity(target) });
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
