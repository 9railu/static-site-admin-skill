/**
 * admin.mjs — Secure local admin UI for static sites
 *
 * Usage: node admin.mjs
 * No external npm packages required — Node.js built-ins only.
 *
 * CUSTOMIZATION: Search for "TODO" comments to find all customization points.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// TODO: CONFIGURATION — adjust these for your project
// ============================================================
const PORT = 3099;
const ROOT = path.resolve(__dirname, '..');   // project root (parent of scripts/)

// Data file — default is a simple JSON array of items
const DATA_FILE = path.join(ROOT, 'data', 'items.json');

// Static files served under /files/ (e.g. uploaded images)
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads');

// Shown in console after deploy
const PRODUCTION_URL = '';  // e.g. 'https://your-site.com'

// Git files/dirs to add on deploy (directory paths catch new files automatically)
const GIT_ADD_PATHS = [
  'data/items.json',
  // 'public/uploads',  // uncomment if uploads should be committed
];
// ============================================================

const CERT_KEY = path.join(__dirname, 'server.key');
const CERT_CRT = path.join(__dirname, 'server.crt');
const COOKIE_NAME = 'admin_tok';
const COOKIE_MAX_AGE = 86400;
const cookieFlags = () =>
  `HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/${USE_HTTPS ? '; Secure' : ''}`;
const TOKEN = crypto.randomBytes(24).toString('base64url');
const PAIR_TTL = 5 * 60 * 1000;

let pairingEnabled = false;
let inviteCode = null;

const pendingPairs = new Map();
const approvedCodes = new Map();
const pairedSessions = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pendingPairs) {
    if (now - p.createdAt > PAIR_TTL) pendingPairs.delete(code);
  }
  for (const [code, p] of approvedCodes) {
    if (now - p.createdAt > PAIR_TTL * 2) approvedCodes.delete(code);
  }
}, 60_000);

// ---- HELPERS ----

const MAX_BODY = 50 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function serveFileSafe(baseDir, rawSegment, res) {
  if (rawSegment.includes('..') || rawSegment.includes('\\')) return sendError(res, 403, 'Forbidden');
  const decoded = decodeURIComponent(rawSegment);
  const resolved = path.resolve(baseDir, decoded);
  const base = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : baseDir;
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return sendError(res, 403, 'Forbidden');
  if (!fs.existsSync(resolved)) return sendError(res, 404, 'Not found');
  const ext = path.extname(resolved).toLowerCase();
  const mimes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.json': 'application/json',
  };
  const mime = mimes[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(resolved);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length });
  res.end(buf);
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const sep = Buffer.from('\r\n--' + boundary);
  const headerSep = Buffer.from('\r\n\r\n');
  let pos = buffer.indexOf(Buffer.from('--' + boundary));
  if (pos === -1) return parts;
  pos += boundary.length + 4;
  while (pos < buffer.length) {
    const next = buffer.indexOf(sep, pos);
    const end = next === -1 ? buffer.length - 2 : next;
    const part = buffer.slice(pos, end);
    const hEnd = part.indexOf(headerSep);
    if (hEnd !== -1) {
      const headers = part.slice(0, hEnd).toString('utf8');
      const body = part.slice(hEnd + 4);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      parts.push({ name: nameMatch?.[1], filename: filenameMatch?.[1], body, headers });
    }
    if (next === -1) break;
    pos = next + sep.length + 2;
  }
  return parts;
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---- SSE ----

function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

function sseStep(res, label, file, args) {
  return new Promise(resolve => {
    res.write('data: ▶ ' + label + '\n\n');
    const child = execFile(file, args, { cwd: ROOT });
    const emit = d => d.toString().split('\n').forEach(l => { if (l.trim()) res.write('data: ' + l.trim() + '\n\n'); });
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('close', resolve);
  });
}

// ---- SECURITY ----

function isPrivateIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' ||
    /^192\.168\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function isAllowedOrigin(origin) {
  try { return isPrivateIp(new URL(origin).hostname); } catch { return false; }
}

function checkAuth(req, url) {
  const cookies = req.headers['cookie'] || '';
  const m = cookies.match(new RegExp(COOKIE_NAME + '=([^;\\s]+)'));
  const cookieVal = m?.[1];
  if (cookieVal === TOKEN) return true;
  if (cookieVal && pairedSessions.has(cookieVal)) return true;
  return url.searchParams.get('token') === TOKEN;
}

function generatePairCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function getLanAddresses() {
  const result = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) result.push(iface.address);
    }
  }
  return result;
}

// ---- PAIRING HANDLERS ----

const pairStatusRateLimit = new Map();
function checkPairStatusRate(ip) {
  const now = Date.now();
  const entry = pairStatusRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    pairStatusRateLimit.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 40) return false;
  entry.count++;
  return true;
}

async function handlePairRequest(req, res) {
  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  try {
    const body = JSON.parse(await readBody(req));
    if (!inviteCode || body.invite !== inviteCode) return sendError(res, 403, 'Invalid invite code');
  } catch { return sendError(res, 400, 'Bad request'); }
  for (const [code, p] of pendingPairs) {
    if (p.peerIp === peerIp && Date.now() - p.createdAt < PAIR_TTL) {
      return sendJSON(res, { code, expiresIn: Math.floor((PAIR_TTL - (Date.now() - p.createdAt)) / 1000) });
    }
  }
  const code = generatePairCode();
  pendingPairs.set(code, { peerIp, createdAt: Date.now() });
  sendJSON(res, { code, expiresIn: Math.floor(PAIR_TTL / 1000) });
}

function handlePairStatus(req, res, url) {
  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!checkPairStatusRate(peerIp)) return sendError(res, 429, 'Too Many Requests');
  const code = url.searchParams.get('code');
  if (!code) return sendError(res, 400, 'code required');
  if (approvedCodes.has(code)) {
    const entry = approvedCodes.get(code);
    if (entry.peerIp !== peerIp) return sendJSON(res, { status: 'pending' });
    approvedCodes.delete(code);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${entry.sessionToken}; ${cookieFlags()}`);
    return sendJSON(res, { status: 'approved' });
  }
  if (pendingPairs.has(code)) {
    const p = pendingPairs.get(code);
    if (Date.now() - p.createdAt > PAIR_TTL) { pendingPairs.delete(code); return sendJSON(res, { status: 'expired' }); }
    return sendJSON(res, { status: 'pending' });
  }
  return sendJSON(res, { status: 'expired' });
}

function handlePairPending(res) {
  const now = Date.now();
  const list = [];
  for (const [code, p] of pendingPairs) {
    if (now - p.createdAt < PAIR_TTL) {
      list.push({ code, peerIp: p.peerIp, expiresIn: Math.floor((PAIR_TTL - (now - p.createdAt)) / 1000) });
    }
  }
  sendJSON(res, list);
}

async function handlePairApprove(req, res) {
  try {
    const { code } = JSON.parse(await readBody(req));
    const pending = pendingPairs.get(code);
    if (!pending) return sendError(res, 404, 'Code not found (may have expired)');
    const sessionToken = crypto.randomBytes(24).toString('base64url');
    pairedSessions.add(sessionToken);
    approvedCodes.set(code, { sessionToken, peerIp: pending.peerIp, createdAt: Date.now() });
    pendingPairs.delete(code);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePairReject(req, res) {
  try {
    const { code } = JSON.parse(await readBody(req));
    pendingPairs.delete(code);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePairSharing(req, res) {
  try {
    const { enabled } = JSON.parse(await readBody(req));
    pairingEnabled = !!enabled;
    if (pairingEnabled) {
      inviteCode = crypto.randomBytes(16).toString('base64url');
    } else {
      inviteCode = null;
      pendingPairs.clear();
      approvedCodes.clear();
    }
    sendJSON(res, { enabled: pairingEnabled, inviteCode });
  } catch (e) { sendError(res, 500, e.message); }
}

// ============================================================
// TODO: DATA HANDLERS — replace with your schema
// ============================================================

/**
 * Default schema: array of { id, title, description, visible }
 * Replace with whatever your site needs.
 */

function handleGetData(res) {
  try {
    sendJSON(res, loadData());
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePostData(req, res) {
  try {
    const data = JSON.parse(await readBody(req));
    saveData(data);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleDeleteItem(req, res) {
  try {
    const { id } = JSON.parse(await readBody(req));
    if (!id) return sendError(res, 400, 'id required');
    const data = loadData();
    const next = data.filter(item => item.id !== id);
    if (next.length === data.length) return sendError(res, 404, 'Item not found');
    saveData(next);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

// TODO: Add upload handler if your project needs file uploads
// async function handleUpload(req, res) { ... }

// ============================================================
// TODO: DEPLOY PIPELINE — adjust filesToAdd for your project
// ============================================================

async function handleDeploy(req, res) {
  startSSE(res);
  const date = new Date().toISOString().slice(0, 10);

  const buildCode = await sseStep(res, 'npm run build', process.platform === 'win32' ? 'cmd' : 'npm', process.platform === 'win32' ? ['/c', 'npm', 'run', 'build'] : ['run', 'build']);
  if (buildCode !== 0) {
    res.write('data: ❌ Build failed\n\n');
    res.write('data: __DONE__\n\n');
    return res.end();
  }
  res.write('data: ✓ Build complete\n\n');

  // TODO: Add all files/dirs that should be committed
  await sseStep(res, 'git add', 'git', ['add', ...GIT_ADD_PATHS]);

  const commitCode = await sseStep(res, 'git commit', 'git', [
    'commit', '-m', 'update: content [' + date + ']',
  ]);
  if (commitCode !== 0) {
    res.write('data: ℹ Nothing to commit\n\n');
    res.write('data: __DONE__\n\n');
    return res.end();
  }
  res.write('data: ✓ Committed\n\n');

  const pushCode = await sseStep(res, 'git push', 'git', ['push']);
  if (pushCode !== 0) {
    res.write('data: ❌ Push failed\n\n');
  } else {
    res.write('data: ✓ Pushed — deploying...\n\n');
    if (PRODUCTION_URL) res.write('data: ' + PRODUCTION_URL + '\n\n');
  }
  res.write('data: __DONE__\n\n');
  res.end();
}

// ---- ROUTER ----

async function router(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const method = req.method;
  const p = url.pathname;

  // ① Private IP only — blocks all internet traffic automatically
  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!isPrivateIp(peerIp)) return sendError(res, 403, 'Forbidden');

  // ② Pairing routes (no auth required — used by LAN devices)
  const isLocalhost = peerIp === '127.0.0.1' || peerIp === '::1';
  if (p === '/pair') {
    if (isLocalhost) { res.writeHead(302, { Location: '/login?token=' + TOKEN }); return res.end(); }
    if (!pairingEnabled) return sendHTML(res, getPairDisabledHTML());
    if (!inviteCode || url.searchParams.get('invite') !== inviteCode) return sendHTML(res, getPairInvalidHTML());
    return sendHTML(res, getPairHTML(inviteCode));
  }
  if (method === 'POST' && p === '/api/pair/request') {
    if (isLocalhost) return sendError(res, 403, 'Use the token URL instead');
    if (!pairingEnabled) return sendError(res, 403, 'Pairing is disabled');
    return handlePairRequest(req, res);
  }
  if (method === 'GET' && p === '/api/pair/status') return handlePairStatus(req, res, url);

  // ③ /login — exchange host token for Cookie
  if (p === '/login') {
    if (url.searchParams.get('token') === TOKEN) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${TOKEN}; ${cookieFlags()}`);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return sendError(res, 401, 'Invalid token');
  }

  // ④ Auth check
  if (!checkAuth(req, url)) {
    res.writeHead(302, { Location: '/pair' });
    return res.end();
  }

  // ⑤ CSRF protection (defense-in-depth on top of SameSite=Strict)
  if (method === 'POST' || method === 'DELETE' || method === 'PATCH') {
    const secFetch = req.headers['sec-fetch-site'];
    if (secFetch && secFetch !== 'same-origin' && secFetch !== 'none') return sendError(res, 403, 'Forbidden');
    const origin = req.headers['origin'];
    if (origin && !isAllowedOrigin(origin)) return sendError(res, 403, 'Forbidden');
  }

  // Core routes
  if (method === 'GET'  && p === '/')              return sendHTML(res, getAdminHTML());
  if (method === 'GET'  && p === '/api/config')    return sendJSON(res, { port: PORT, lan: getLanAddresses(), pairingEnabled, inviteCode, productionUrl: PRODUCTION_URL });

  // Data CRUD — maps to DATA_FILE
  if (method === 'GET'    && p === '/api/data')    return handleGetData(res);
  if (method === 'POST'   && p === '/api/data')    return handlePostData(req, res);
  if (method === 'DELETE' && p === '/api/data')    return handleDeleteItem(req, res);

  // Deploy
  if (method === 'GET'  && p === '/api/deploy')    return handleDeploy(req, res);

  // File serving (uploaded files)
  if (method === 'GET'  && p.startsWith('/files/')) return serveFileSafe(UPLOADS_DIR, p.slice(7), res);

  // Pairing management (localhost only)
  if (p.startsWith('/api/pair/') && !isLocalhost) return sendError(res, 403, 'Host only');
  if (method === 'GET'  && p === '/api/pair/pending')  return handlePairPending(res);
  if (method === 'POST' && p === '/api/pair/approve')  return handlePairApprove(req, res);
  if (method === 'POST' && p === '/api/pair/reject')   return handlePairReject(req, res);
  if (method === 'POST' && p === '/api/pair/sharing')  return handlePairSharing(req, res);

  // TODO: Add your custom API routes here

  sendError(res, 404, 'Not found');
}

// ---- TLS ----

function ensureCert() {
  if (fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT)) return true;
  const lanIps = getLanAddresses();
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map(ip => 'IP:' + ip)].join(',');
  // All args come from hardcoded constants or system-detected IPs — no user input involved.
  // Using spawnSync with an args array (not a shell string) to avoid any shell injection surface.
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  for (const bin of candidates) {
    try {
      const result = spawnSync(bin, [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', CERT_KEY, '-out', CERT_CRT,
        '-days', '365', '-nodes',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=' + san,
      ], { stdio: 'pipe' });
      if (result.status === 0) {
        console.log('\x1b[32m✓ TLS certificate generated (valid 365 days)\x1b[0m');
        return true;
      }
    } catch (_) {}
  }
  console.warn('\x1b[33m⚠ openssl not found — starting on HTTP (no eavesdropping protection)\x1b[0m');
  return false;
}

const USE_HTTPS = ensureCert();
const PROTOCOL = USE_HTTPS ? 'https' : 'http';

const handler = async (req, res) => {
  try { await router(req, res); }
  catch (e) { sendError(res, 500, e.message); }
};

const server = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CRT) }, handler)
  : http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const localUrl = PROTOCOL + '://localhost:' + PORT + '/login?token=' + TOKEN;
  console.log('\x1b[32mAdmin server running\x1b[0m');
  console.log('\x1b[1mLocal:\x1b[0m ' + localUrl);
  const lanIps = getLanAddresses();
  if (lanIps.length) {
    console.log('\x1b[36mLAN devices — enable sharing in the LAN tab for invite URL\x1b[0m');
  }
  // Auto-open browser (Windows)
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', localUrl], { shell: false });
  }
});

// ---- HTML ----

function getPairDisabledHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Access Request</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0b14;color:#c8c8d0;font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px 40px;text-align:center;max-width:320px}
h1{font-size:15px;font-weight:600;margin-bottom:8px}p{font-size:13px;color:#6a6a7a}</style></head>
<body><div class="box"><h1>🔒 Sharing is disabled</h1><p>Ask the host to enable LAN sharing in the admin UI.</p></div></body></html>`;
}

function getPairInvalidHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Access Request</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0b14;color:#c8c8d0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px 40px;text-align:center;max-width:340px;width:100%}
h1{font-size:15px;font-weight:600;margin-bottom:8px}p{font-size:13px;color:#6a6a7a}</style></head>
<body><div class="box"><h1>🔗 Invalid invite URL</h1><p>Ask the host for a new invite URL.</p></div></body></html>`;
}

function getPairHTML(invite) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Access Request</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0b14;color:#c8c8d0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px 40px;text-align:center;max-width:340px;width:100%}
h1{font-size:16px;font-weight:600;margin-bottom:8px}
.sub{font-size:13px;color:#6a6a7a;margin-bottom:24px}
.code{font-size:48px;font-weight:700;letter-spacing:12px;color:#fff;margin:24px 0;font-variant-numeric:tabular-nums}
.status{font-size:13px;color:#6a6a7a;min-height:20px}
.status.waiting{color:#a07020}.status.approved{color:#2a8a4a}.status.expired{color:#c05050}
button{background:#3050a0;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-size:14px;cursor:pointer;margin-top:8px}
button:hover{background:#4060c0}button:disabled{opacity:.5;cursor:default}
</style>
</head>
<body>
<div class="box">
  <h1>Admin Access Request</h1>
  <p class="sub">Show the code below to the host — they'll approve your access</p>
  <div id="main">
    <button id="req-btn" onclick="requestCode()">Request access</button>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
let pollTimer = null;

async function requestCode() {
  document.getElementById('req-btn').disabled = true;
  document.getElementById('status').textContent = 'Requesting...';
  document.getElementById('status').className = 'status';
  try {
    const r = await fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: '${invite}' }),
    });
    const d = await r.json();
    showCode(d.code, d.expiresIn);
  } catch(e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
    document.getElementById('req-btn').disabled = false;
  }
}

function showCode(code, expiresIn) {
  document.getElementById('main').innerHTML =
    '<div class="code">' + code + '</div>' +
    '<p style="font-size:12px;color:#6a6a7a">Expires in ' + Math.floor(expiresIn / 60) + ' min</p>';
  document.getElementById('status').textContent = 'Waiting for host approval...';
  document.getElementById('status').className = 'status waiting';
  startPolling(code);
}

function startPolling(code) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/pair/status?code=' + code);
      const d = await r.json();
      if (d.status === 'approved') {
        clearInterval(pollTimer);
        document.getElementById('status').textContent = '✓ Approved — redirecting...';
        document.getElementById('status').className = 'status approved';
        setTimeout(() => { location.href = '/'; }, 800);
      } else if (d.status === 'expired') {
        clearInterval(pollTimer);
        document.getElementById('status').textContent = 'Code expired';
        document.getElementById('status').className = 'status expired';
        document.getElementById('main').innerHTML = '<button onclick="requestCode()">Request again</button>';
      }
    } catch(e) {}
  }, 2000);
}
</script>
</body>
</html>`;
}

// ============================================================
// TODO: ADMIN UI — customize the HTML for your data schema
// ============================================================

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0b14;--bg2:#12141f;--bg3:#1a1d2e;--text:#c8c8d0;--muted:#6a6a7a;--accent:#3050a0;--accent2:#4060c0;--border:#2a2d3e;--green:#2a8a4a;--yellow:#a07020;--red:#c05050}
body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px;min-height:100vh;padding-bottom:68px}
button{cursor:pointer;font:inherit;border:none;outline:none}
input,select,textarea{font:inherit;background:var(--bg3);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:4px;width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--accent2);outline:none}
.admin-header{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:32px;height:56px;position:sticky;top:0;z-index:100}
.admin-header h1{font-size:16px;font-weight:600;letter-spacing:.05em}
.tabs{display:flex}
.tab-btn{padding:0 20px;height:56px;background:none;color:var(--muted);font-size:14px;border-bottom:2px solid transparent;transition:all .2s}
.tab-btn.active{color:var(--text);border-bottom-color:var(--accent2)}
.tab-btn:hover:not(.active){color:var(--text)}
.tab-content{display:none;padding:24px}.tab-content.active{display:block}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
.section-title{font-size:15px;font-weight:600;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;transition:all .15s;cursor:pointer;border:none}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent2)}
.btn-secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--muted)}
.btn-ghost{background:none;color:var(--muted);padding:4px 8px}.btn-ghost:hover{color:var(--text)}
.btn-danger{background:none;color:var(--red);border:1px solid var(--red);padding:4px 10px;font-size:12px}.btn-danger:hover{background:var(--red);color:#fff}
.btn-sm{padding:5px 10px;font-size:12px}
.fixed-bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg2);border-top:1px solid var(--border);padding:10px 24px;display:flex;align-items:center;gap:10px;z-index:200}
.dirty-badge{font-size:12px;color:var(--yellow);display:none}.dirty-badge.show{display:inline}
.toast{position:fixed;bottom:76px;left:50%;transform:translateX(-50%) translateY(12px);background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 20px;font-size:13px;z-index:300;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red);color:var(--red)}
.progress-box{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:12px;color:var(--muted);max-height:160px;overflow-y:auto;display:none}
.progress-box.active{display:block}
/* Item list */
.item-row{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg3);border-radius:6px;margin-bottom:8px}
.item-row-title{flex:1;font-size:13px;font-weight:500}
.item-row-desc{font-size:12px;color:var(--muted);margin-top:2px}
.item-badge{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg2);border:1px solid var(--border)}
.item-badge.visible{border-color:var(--green);color:var(--green)}
.item-badge.hidden{border-color:var(--red);color:var(--red)}
/* Add form */
.add-form{display:grid;gap:10px;margin-bottom:16px}
.add-form label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
/* LAN pairing */
.pair-host-section{display:none}
</style>
</head>
<body>

<div class="admin-header">
  <h1>Admin</h1>
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('data',event)">Content</button>
    <button class="tab-btn" onclick="switchTab('deploy',event)">Deploy</button>
    <button class="tab-btn" onclick="switchTab('lan',event)">LAN Access</button>
  </div>
</div>

<!-- Content tab -->
<div class="tab-content active" id="tab-data">
  <div class="section">
    <div class="section-title">Add item</div>
    <div class="add-form">
      <div><label>Title</label><input id="new-title" placeholder="Item title"></div>
      <div><label>Description</label><input id="new-desc" placeholder="Optional description"></div>
    </div>
    <button class="btn btn-primary" onclick="addItem()">+ Add</button>
  </div>

  <div class="section">
    <div class="section-title">Items <span id="item-count" style="font-size:12px;font-weight:400;color:var(--muted)"></span></div>
    <div id="item-list"></div>
  </div>
</div>

<!-- Deploy tab -->
<div class="tab-content" id="tab-deploy">
  <div class="section">
    <div class="section-title">Deploy</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Runs: npm run build → git add → git commit → git push</p>
    <button class="btn btn-primary" onclick="runDeploy()">&#128640; Deploy</button>
    <div class="progress-box" id="deploy-progress"></div>
  </div>
</div>

<!-- LAN tab -->
<div class="tab-content" id="tab-lan">
  <div class="section pair-host-section" id="pair-host-section">
    <div class="section-title">LAN Sharing</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <button id="sharing-toggle-btn" class="btn" onclick="toggleSharing()" style="min-width:80px">Loading</button>
      <span id="sharing-status-text" style="font-size:13px;color:var(--muted)"></span>
    </div>
    <div id="pair-url-section" style="display:none">
      <p style="font-size:13px;color:var(--muted);margin-bottom:10px">Share this URL with LAN devices to let them request access.</p>
      <div id="pair-url-list" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  </div>

  <div class="section" id="pending-section" style="display:none">
    <div class="section-title">Pending devices <span id="pending-badge" style="font-size:12px;font-weight:400;color:var(--muted)"></span></div>
    <div id="pending-list"><div style="color:var(--muted);font-size:13px">No pending requests</div></div>
  </div>
</div>

<div class="fixed-bar">
  <button class="btn btn-primary" onclick="saveData()">&#128190; Save</button>
  <span class="dirty-badge" id="dirty-badge">● Unsaved changes</span>
</div>

<script>
// ===== STATE =====
let dataState = [];
const ADMIN_PORT = ${PORT};

// ===== TABS =====
function switchTab(name, event) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'lan') loadLan();
}

// ===== DATA =====
async function loadData() {
  try {
    dataState = await fetch('/api/data').then(r => r.json());
    renderItems();
  } catch(e) { showToast('Load failed: ' + e.message, 'err'); }
}

function renderItems() {
  const list = document.getElementById('item-list');
  document.getElementById('item-count').textContent = dataState.length + ' items';
  if (!dataState.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px">No items yet.</div>';
    return;
  }
  list.innerHTML = dataState.map((item, i) =>
    '<div class="item-row">' +
      '<div style="flex:1">' +
        '<div class="item-row-title">' + esc(item.title || '(no title)') + '</div>' +
        (item.description ? '<div class="item-row-desc">' + esc(item.description) + '</div>' : '') +
      '</div>' +
      '<span class="item-badge ' + (item.visible ? 'visible' : 'hidden') + '">' + (item.visible ? 'visible' : 'hidden') + '</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="toggleVisible(' + i + ')">' + (item.visible ? 'Hide' : 'Show') + '</button>' +
      '<button class="btn btn-danger" onclick="deleteItem(' + esc(JSON.stringify(item.id)) + ')">Del</button>' +
    '</div>'
  ).join('');
}

function addItem() {
  const title = document.getElementById('new-title').value.trim();
  const desc = document.getElementById('new-desc').value.trim();
  if (!title) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  dataState.push({ id, title, description: desc || '', visible: true });
  document.getElementById('new-title').value = '';
  document.getElementById('new-desc').value = '';
  markDirty();
  renderItems();
}

function toggleVisible(i) {
  dataState[i].visible = !dataState[i].visible;
  markDirty();
  renderItems();
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  const r = await fetch('/api/data', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (r.ok) {
    dataState = dataState.filter(x => x.id !== id);
    renderItems();
    showToast('Deleted ✓', 'ok');
  } else {
    showToast('Delete failed', 'err');
  }
}

async function saveData() {
  try {
    await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dataState) });
    markClean();
    showToast('Saved ✓', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'err'); }
}

// ===== DEPLOY =====
async function runDeploy() {
  const box = document.getElementById('deploy-progress');
  box.innerHTML = '';
  box.classList.add('active');
  const es = new EventSource('/api/deploy');
  es.onmessage = e => {
    if (e.data.startsWith('__DONE__')) { es.close(); const d = document.createElement('div'); d.style.color = 'var(--green)'; d.textContent = 'Done ✓'; box.appendChild(d); box.scrollTop = box.scrollHeight; return; }
    if (e.data.trim()) { const d = document.createElement('div'); d.textContent = e.data; if (e.data.startsWith('❌')) d.style.color = 'var(--red)'; else if (e.data.startsWith('✓')) d.style.color = 'var(--green)'; box.appendChild(d); box.scrollTop = box.scrollHeight; }
  };
}

// ===== LAN / PAIRING =====
let _sharingEnabled = false;
let _inviteCode = null;
let lanPollTimer = null;

async function loadLan() {
  const isHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  document.getElementById('pair-host-section').style.display = isHost ? '' : 'none';
  document.getElementById('pending-section').style.display = isHost ? '' : 'none';
  if (!isHost) return;
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  _sharingEnabled = cfg.pairingEnabled ?? false;
  _inviteCode = cfg.inviteCode ?? null;
  renderSharingState(cfg.lan || []);
  loadPending();
  if (!lanPollTimer) lanPollTimer = setInterval(loadPending, 3000);
}

function renderSharingState(lanIps) {
  const btn = document.getElementById('sharing-toggle-btn');
  const text = document.getElementById('sharing-status-text');
  const urlSection = document.getElementById('pair-url-section');
  if (_sharingEnabled) {
    btn.textContent = '🟢 ON';
    btn.className = 'btn btn-ghost';
    text.textContent = 'Accepting access requests from LAN devices';
    urlSection.style.display = '';
    const urls = (lanIps || []).map(ip => location.protocol + '//' + ip + ':' + ADMIN_PORT + '/pair?invite=' + (_inviteCode || ''));
    document.getElementById('pair-url-list').innerHTML = urls.length
      ? urls.map(u => '<div style="display:flex;align-items:center;gap:8px"><code style="background:var(--bg3);padding:4px 10px;border-radius:4px;font-size:12px;flex:1;word-break:break-all">' + esc(u) + '</code><button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(' + esc(JSON.stringify(u)) + ')">Copy</button></div>').join('')
      : '<div style="color:var(--muted);font-size:13px">No LAN IPs detected</div>';
  } else {
    btn.textContent = '⚫ OFF';
    btn.className = 'btn btn-secondary';
    text.textContent = 'LAN sharing is off';
    urlSection.style.display = 'none';
  }
}

async function toggleSharing() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  const resp = await fetch('/api/pair/sharing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !_sharingEnabled }) });
  if (resp.ok) {
    const d = await resp.json();
    _sharingEnabled = d.enabled;
    _inviteCode = d.inviteCode ?? null;
    renderSharingState(cfg.lan || []);
  }
}

async function loadPending() {
  let list;
  try { list = await fetch('/api/pair/pending').then(r => r.json()); } catch { return; }
  const el = document.getElementById('pending-list');
  const badge = document.getElementById('pending-badge');
  if (!list.length) { badge.textContent = ''; el.innerHTML = '<div style="color:var(--muted);font-size:13px">No pending requests</div>'; return; }
  badge.textContent = '(' + list.length + ')';
  el.innerHTML = list.map(p =>
    '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:8px">' +
      '<div style="flex:1"><div style="font-size:13px;font-weight:500">' + esc(p.peerIp) + '</div>' +
      '<div style="font-size:28px;font-weight:700;letter-spacing:8px;color:#fff;margin:4px 0">' + esc(p.code) + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + p.expiresIn + 's remaining</div></div>' +
      '<button class="btn btn-primary btn-sm" onclick="pairApprove(' + esc(JSON.stringify(p.code)) + ')">Approve</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="pairReject(' + esc(JSON.stringify(p.code)) + ')">Reject</button>' +
    '</div>'
  ).join('');
}

async function pairApprove(code) {
  await fetch('/api/pair/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
  loadPending();
}
async function pairReject(code) {
  await fetch('/api/pair/reject', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
  loadPending();
}

// ===== UTILS =====
// esc() is the XSS guard: all user-supplied strings pass through it before innerHTML insertion.
// DOMPurify is not used — this project is zero-dependency by design, and esc() is sufficient
// for this admin-only tool where the only inputs are from the authenticated operator themselves.
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function markDirty() { document.getElementById('dirty-badge')?.classList.add('show'); }
function markClean() { document.getElementById('dirty-badge')?.classList.remove('show'); }

let _toastTimer;
function showToast(msg, type) {
  if (_toastTimer) clearTimeout(_toastTimer);
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  _toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

loadData();
</script>
</body>
</html>`;
}
