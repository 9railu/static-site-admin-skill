/**
 * admin.mjs — Blog post manager example
 *
 * Data schema: data/posts.json — array of:
 *   { id, title, slug, excerpt, content, date, published }
 *
 * Usage: node scripts/admin.mjs
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

// ---- CONFIGURATION ----
const PORT = 3099;
const ROOT = path.resolve(__dirname, '..');
const POSTS_FILE = path.join(ROOT, 'data', 'posts.json');
const GIT_ADD_PATHS = ['data/posts.json'];
const PRODUCTION_URL = '';

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
  for (const [code, p] of pendingPairs) if (now - p.createdAt > PAIR_TTL) pendingPairs.delete(code);
  for (const [code, p] of approvedCodes) if (now - p.createdAt > PAIR_TTL * 2) approvedCodes.delete(code);
}, 60_000);

// ---- HELPERS ----

const MAX_BODY = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => { total += c.length; if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHTML(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
function sendError(res, code, msg) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); }

function loadPosts() {
  try { if (!fs.existsSync(POSTS_FILE)) return []; return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch { return []; }
}
function savePosts(posts) {
  fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true });
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), 'utf8');
}

function slugify(title) {
  return title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 64);
}

// ---- SSE ----

function startSSE(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
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
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function isAllowedOrigin(origin) { try { return isPrivateIp(new URL(origin).hostname); } catch { return false; } }
function checkAuth(req, url) {
  const m = (req.headers['cookie'] || '').match(new RegExp(COOKIE_NAME + '=([^;\\s]+)'));
  const v = m?.[1];
  return v === TOKEN || (v && pairedSessions.has(v)) || url.searchParams.get('token') === TOKEN;
}
function generatePairCode() { return String(crypto.randomInt(100000, 1000000)); }
function getLanAddresses() {
  const r = [];
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) r.push(i.address);
  return r;
}

// ---- PAIRING ----

const pairRateLimit = new Map();
function checkPairRate(ip) {
  const now = Date.now();
  const e = pairRateLimit.get(ip);
  if (!e || now > e.resetAt) { pairRateLimit.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 40) return false;
  e.count++;
  return true;
}

async function handlePairRequest(req, res) {
  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  try {
    const body = JSON.parse(await readBody(req));
    if (!inviteCode || body.invite !== inviteCode) return sendError(res, 403, 'Invalid invite code');
  } catch { return sendError(res, 400, 'Bad request'); }
  for (const [code, p] of pendingPairs)
    if (p.peerIp === peerIp && Date.now() - p.createdAt < PAIR_TTL)
      return sendJSON(res, { code, expiresIn: Math.floor((PAIR_TTL - (Date.now() - p.createdAt)) / 1000) });
  const code = generatePairCode();
  pendingPairs.set(code, { peerIp, createdAt: Date.now() });
  sendJSON(res, { code, expiresIn: Math.floor(PAIR_TTL / 1000) });
}

function handlePairStatus(req, res, url) {
  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!checkPairRate(peerIp)) return sendError(res, 429, 'Too Many Requests');
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
  for (const [code, p] of pendingPairs)
    if (now - p.createdAt < PAIR_TTL) list.push({ code, peerIp: p.peerIp, expiresIn: Math.floor((PAIR_TTL - (now - p.createdAt)) / 1000) });
  sendJSON(res, list);
}

async function handlePairApprove(req, res) {
  try {
    const { code } = JSON.parse(await readBody(req));
    const pending = pendingPairs.get(code);
    if (!pending) return sendError(res, 404, 'Code not found');
    const sessionToken = crypto.randomBytes(24).toString('base64url');
    pairedSessions.add(sessionToken);
    approvedCodes.set(code, { sessionToken, peerIp: pending.peerIp, createdAt: Date.now() });
    pendingPairs.delete(code);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePairReject(req, res) {
  try { const { code } = JSON.parse(await readBody(req)); pendingPairs.delete(code); sendJSON(res, { ok: true }); }
  catch (e) { sendError(res, 500, e.message); }
}

async function handlePairSharing(req, res) {
  try {
    const { enabled } = JSON.parse(await readBody(req));
    pairingEnabled = !!enabled;
    inviteCode = pairingEnabled ? crypto.randomBytes(16).toString('base64url') : null;
    if (!pairingEnabled) { pendingPairs.clear(); approvedCodes.clear(); }
    sendJSON(res, { enabled: pairingEnabled, inviteCode });
  } catch (e) { sendError(res, 500, e.message); }
}

// ---- BLOG POST HANDLERS ----

function handleGetPosts(res) {
  sendJSON(res, loadPosts());
}

async function handlePostPosts(req, res) {
  try {
    const posts = JSON.parse(await readBody(req));
    savePosts(posts);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleCreatePost(req, res) {
  try {
    const { title, excerpt, content, date, published } = JSON.parse(await readBody(req));
    if (!title) return sendError(res, 400, 'title required');
    const posts = loadPosts();
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    posts.unshift({
      id,
      title,
      slug: slugify(title),
      excerpt: excerpt || '',
      content: content || '',
      date: date || new Date().toISOString().slice(0, 10),
      published: published ?? false,
    });
    savePosts(posts);
    sendJSON(res, { ok: true, id });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleUpdatePost(req, res) {
  try {
    const update = JSON.parse(await readBody(req));
    if (!update.id) return sendError(res, 400, 'id required');
    const posts = loadPosts();
    const idx = posts.findIndex(p => p.id === update.id);
    if (idx === -1) return sendError(res, 404, 'Post not found');
    posts[idx] = { ...posts[idx], ...update };
    savePosts(posts);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleDeletePost(req, res) {
  try {
    const { id } = JSON.parse(await readBody(req));
    const posts = loadPosts();
    const next = posts.filter(p => p.id !== id);
    if (next.length === posts.length) return sendError(res, 404, 'Post not found');
    savePosts(next);
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

// ---- DEPLOY ----

async function handleDeploy(req, res) {
  startSSE(res);
  const date = new Date().toISOString().slice(0, 10);

  const buildArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', 'build'] : ['run', 'build'];
  const buildCmd = process.platform === 'win32' ? 'cmd' : 'npm';
  const buildCode = await sseStep(res, 'npm run build', buildCmd, buildArgs);
  if (buildCode !== 0) { res.write('data: ❌ Build failed\n\ndata: __DONE__\n\n'); return res.end(); }
  res.write('data: ✓ Build complete\n\n');

  await sseStep(res, 'git add', 'git', ['add', ...GIT_ADD_PATHS]);

  const commitCode = await sseStep(res, 'git commit', 'git', ['commit', '-m', 'update: posts [' + date + ']']);
  if (commitCode !== 0) { res.write('data: ℹ Nothing to commit\n\ndata: __DONE__\n\n'); return res.end(); }
  res.write('data: ✓ Committed\n\n');

  const pushCode = await sseStep(res, 'git push', 'git', ['push']);
  res.write(pushCode !== 0 ? 'data: ❌ Push failed\n\n' : 'data: ✓ Pushed\n\n');
  res.write('data: __DONE__\n\n');
  res.end();
}

// ---- ROUTER ----

async function router(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const method = req.method;
  const p = url.pathname;

  const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!isPrivateIp(peerIp)) return sendError(res, 403, 'Forbidden');

  const isLocalhost = peerIp === '127.0.0.1' || peerIp === '::1';

  if (p === '/pair') {
    if (isLocalhost) { res.writeHead(302, { Location: '/login?token=' + TOKEN }); return res.end(); }
    if (!pairingEnabled) return sendHTML(res, getPairDisabledHTML());
    if (!inviteCode || url.searchParams.get('invite') !== inviteCode) return sendHTML(res, getPairInvalidHTML());
    return sendHTML(res, getPairHTML(inviteCode));
  }
  if (method === 'POST' && p === '/api/pair/request') {
    if (isLocalhost) return sendError(res, 403, 'Use the token URL');
    if (!pairingEnabled) return sendError(res, 403, 'Pairing disabled');
    return handlePairRequest(req, res);
  }
  if (method === 'GET' && p === '/api/pair/status') return handlePairStatus(req, res, url);

  if (p === '/login') {
    if (url.searchParams.get('token') === TOKEN) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${TOKEN}; ${cookieFlags()}`);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return sendError(res, 401, 'Invalid token');
  }

  if (!checkAuth(req, url)) { res.writeHead(302, { Location: '/pair' }); return res.end(); }

  if (method === 'POST' || method === 'DELETE' || method === 'PATCH') {
    const sf = req.headers['sec-fetch-site'];
    if (sf && sf !== 'same-origin' && sf !== 'none') return sendError(res, 403, 'Forbidden');
    const origin = req.headers['origin'];
    if (origin && !isAllowedOrigin(origin)) return sendError(res, 403, 'Forbidden');
  }

  if (method === 'GET'    && p === '/')                   return sendHTML(res, getAdminHTML());
  if (method === 'GET'    && p === '/api/config')         return sendJSON(res, { port: PORT, lan: getLanAddresses(), pairingEnabled, inviteCode });
  if (method === 'GET'    && p === '/api/posts')          return handleGetPosts(res);
  if (method === 'POST'   && p === '/api/posts')          return handlePostPosts(req, res);
  if (method === 'POST'   && p === '/api/posts/create')   return handleCreatePost(req, res);
  if (method === 'PATCH'  && p === '/api/posts/update')   return handleUpdatePost(req, res);
  if (method === 'DELETE' && p === '/api/posts')          return handleDeletePost(req, res);
  if (method === 'GET'    && p === '/api/deploy')         return handleDeploy(req, res);

  if (p.startsWith('/api/pair/') && !isLocalhost) return sendError(res, 403, 'Host only');
  if (method === 'GET'  && p === '/api/pair/pending')  return handlePairPending(res);
  if (method === 'POST' && p === '/api/pair/approve')  return handlePairApprove(req, res);
  if (method === 'POST' && p === '/api/pair/reject')   return handlePairReject(req, res);
  if (method === 'POST' && p === '/api/pair/sharing')  return handlePairSharing(req, res);

  sendError(res, 404, 'Not found');
}

// ---- TLS ----

function ensureCert() {
  if (fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT)) return true;
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...getLanAddresses().map(ip => 'IP:' + ip)].join(',');
  for (const bin of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    try {
      const r = spawnSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', CERT_KEY, '-out', CERT_CRT, '-days', '365', '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=' + san], { stdio: 'pipe' });
      if (r.status === 0) { console.log('\x1b[32m✓ TLS cert generated\x1b[0m'); return true; }
    } catch (_) {}
  }
  console.warn('\x1b[33m⚠ openssl not found — using HTTP\x1b[0m');
  return false;
}

const USE_HTTPS = ensureCert();
const PROTOCOL = USE_HTTPS ? 'https' : 'http';
const handler = async (req, res) => { try { await router(req, res); } catch (e) { sendError(res, 500, e.message); } };
const server = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CRT) }, handler)
  : http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const localUrl = PROTOCOL + '://localhost:' + PORT + '/login?token=' + TOKEN;
  console.log('\x1b[32mBlog admin running\x1b[0m  ' + localUrl);
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', localUrl], { shell: false });
});

// ---- HTML ----

function getPairDisabledHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title><style>body{background:#0a0b14;color:#c8c8d0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px;text-align:center;max-width:320px}</style></head><body><div class="box"><h2>🔒 Sharing disabled</h2><p style="color:#6a6a7a;font-size:13px;margin-top:8px">Ask the host to enable LAN sharing.</p></div></body></html>`;
}

function getPairInvalidHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title><style>body{background:#0a0b14;color:#c8c8d0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px;text-align:center;max-width:320px}</style></head><body><div class="box"><h2>🔗 Invalid invite URL</h2><p style="color:#6a6a7a;font-size:13px;margin-top:8px">Ask the host for a new invite URL.</p></div></body></html>`;
}

function getPairHTML(invite) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Request</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0b14;color:#c8c8d0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#12141f;border:1px solid #2a2d3e;border-radius:12px;padding:32px;text-align:center;max-width:340px;width:100%}
h1{font-size:16px;margin-bottom:8px}.sub{font-size:13px;color:#6a6a7a;margin-bottom:24px}
.code{font-size:48px;font-weight:700;letter-spacing:12px;color:#fff;margin:24px 0}
.status{font-size:13px;color:#6a6a7a;min-height:20px}.waiting{color:#a07020}.approved{color:#2a8a4a}.expired{color:#c05050}
button{background:#3050a0;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-size:14px;cursor:pointer;margin-top:8px}
button:disabled{opacity:.5}</style></head>
<body><div class="box">
<h1>Access Request</h1><p class="sub">Show the 6-digit code to the host</p>
<div id="main"><button id="req-btn" onclick="requestCode()">Request access</button></div>
<div class="status" id="status"></div>
</div>
<script>
let pt=null;
async function requestCode(){
  document.getElementById('req-btn').disabled=true;
  document.getElementById('status').textContent='Requesting...';
  try{
    const r=await fetch('/api/pair/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:'${invite}'})});
    const d=await r.json();
    document.getElementById('main').innerHTML='<div class="code">'+d.code+'</div><p style="font-size:12px;color:#6a6a7a">Expires in '+Math.floor(d.expiresIn/60)+' min</p>';
    document.getElementById('status').textContent='Waiting for host approval...';
    document.getElementById('status').className='status waiting';
    pt=setInterval(async()=>{
      const s=await fetch('/api/pair/status?code='+d.code).then(r=>r.json()).catch(()=>({}));
      if(s.status==='approved'){clearInterval(pt);document.getElementById('status').textContent='✓ Approved';document.getElementById('status').className='status approved';setTimeout(()=>{location.href='/'},800);}
      else if(s.status==='expired'){clearInterval(pt);document.getElementById('status').textContent='Code expired';document.getElementById('status').className='status expired';document.getElementById('main').innerHTML='<button onclick="requestCode()">Try again</button>';}
    },2000);
  }catch(e){document.getElementById('status').textContent='Error: '+e.message;document.getElementById('req-btn').disabled=false;}
}
</script></body></html>`;
}

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0b14;--bg2:#12141f;--bg3:#1a1d2e;--text:#c8c8d0;--muted:#6a6a7a;--accent:#3050a0;--accent2:#4060c0;--border:#2a2d3e;--green:#2a8a4a;--yellow:#a07020;--red:#c05050}
body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px;min-height:100vh;padding-bottom:16px}
button{cursor:pointer;font:inherit;border:none;outline:none}
input,textarea{font:inherit;background:var(--bg3);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:4px;width:100%}
input:focus,textarea:focus{border-color:var(--accent2);outline:none}
.admin-header{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:32px;height:56px;position:sticky;top:0;z-index:100}
.admin-header h1{font-size:16px;font-weight:600}
.tabs{display:flex}
.tab-btn{padding:0 20px;height:56px;background:none;color:var(--muted);font-size:14px;border-bottom:2px solid transparent;transition:all .2s}
.tab-btn.active{color:var(--text);border-bottom-color:var(--accent2)}
.tab-content{display:none;padding:24px}.tab-content.active{display:block}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
.section-title{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;transition:all .15s;border:none;cursor:pointer}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent2)}
.btn-secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--muted)}
.btn-ghost{background:none;color:var(--muted);padding:4px 8px}.btn-ghost:hover{color:var(--text)}
.btn-danger{background:none;color:var(--red);border:1px solid var(--red);padding:4px 10px;font-size:12px}.btn-danger:hover{background:var(--red);color:#fff}
.btn-sm{padding:5px 10px;font-size:12px}
.badge-pub{background:#1a3020;color:var(--green);border:1px solid var(--green);font-size:11px;padding:2px 8px;border-radius:10px}
.badge-draft{background:#2a2010;color:var(--yellow);border:1px solid var(--yellow);font-size:11px;padding:2px 8px;border-radius:10px}
.post-row{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:10px}
.post-row-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.post-title{flex:1;font-size:14px;font-weight:600}
.post-date{font-size:11px;color:var(--muted)}
.post-excerpt{font-size:12px;color:var(--muted);margin-bottom:10px}
.post-actions{display:flex;gap:8px;align-items:center}
/* editor modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:400;display:none;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:min(720px,95vw);max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.modal-title{font-size:16px;font-weight:600}
.form-row{display:flex;flex-direction:column;gap:4px}
.form-row label{font-size:12px;color:var(--muted)}
.form-row textarea{resize:vertical;min-height:200px}
.form-row-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
.progress-box{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:12px;color:var(--muted);max-height:160px;overflow-y:auto;display:none}
.progress-box.active{display:block}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(12px);background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 20px;font-size:13px;z-index:300;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red);color:var(--red)}
</style>
</head>
<body>

<div class="admin-header">
  <h1>Blog Admin</h1>
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('posts',event)">Posts</button>
    <button class="tab-btn" onclick="switchTab('deploy',event)">Deploy</button>
    <button class="tab-btn" onclick="switchTab('lan',event)">LAN Access</button>
  </div>
</div>

<!-- Posts tab -->
<div class="tab-content active" id="tab-posts">
  <div class="section">
    <div class="section-title">
      Posts <span id="post-count" style="font-size:12px;font-weight:400;color:var(--muted)"></span>
      <button class="btn btn-primary btn-sm" onclick="openNewPostModal()">+ New post</button>
    </div>
    <div id="post-list"><div style="color:var(--muted);font-size:13px">Loading...</div></div>
  </div>
</div>

<!-- Deploy tab -->
<div class="tab-content" id="tab-deploy">
  <div class="section">
    <div class="section-title">Deploy</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">npm run build → git add → commit → push</p>
    <button class="btn btn-primary" onclick="runDeploy()">&#128640; Deploy</button>
    <div class="progress-box" id="deploy-progress"></div>
  </div>
</div>

<!-- LAN tab -->
<div class="tab-content" id="tab-lan">
  <div class="section" id="pair-host-section" style="display:none">
    <div class="section-title">LAN Sharing</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <button id="sharing-toggle-btn" class="btn btn-secondary" onclick="toggleSharing()">⚫ OFF</button>
      <span id="sharing-status-text" style="font-size:13px;color:var(--muted)">LAN sharing is off</span>
    </div>
    <div id="pair-url-section" style="display:none">
      <p style="font-size:13px;color:var(--muted);margin-bottom:10px">Share this URL with LAN devices.</p>
      <div id="pair-url-list"></div>
    </div>
  </div>
  <div class="section" id="pending-section" style="display:none">
    <div class="section-title">Pending <span id="pending-badge" style="font-size:12px;font-weight:400;color:var(--muted)"></span></div>
    <div id="pending-list"><div style="color:var(--muted);font-size:13px">No pending requests</div></div>
  </div>
</div>

<!-- Edit modal -->
<div class="modal-bg" id="edit-modal" onclick="e=>e.target===this&&closeModal()">
  <div class="modal">
    <div class="modal-title" id="modal-title">New Post</div>
    <input type="hidden" id="edit-id">
    <div class="form-row"><label>Title</label><input id="edit-title" placeholder="Post title"></div>
    <div class="form-row-2">
      <div class="form-row"><label>Date</label><input id="edit-date" type="date"></div>
      <div class="form-row"><label>Slug (auto-generated if empty)</label><input id="edit-slug" placeholder="my-post-slug"></div>
    </div>
    <div class="form-row"><label>Excerpt</label><input id="edit-excerpt" placeholder="Short summary"></div>
    <div class="form-row"><label>Content (Markdown)</label><textarea id="edit-content" rows="12" placeholder="# Heading&#10;&#10;Your content here..."></textarea></div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="edit-published" style="width:auto"> Published
    </label>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="savePost()">Save</button>
    </div>
  </div>
</div>

<script>
const ADMIN_PORT = ${PORT};
let postsState = [];
let _editMode = 'create';
let _sharingEnabled = false;
let _inviteCode = null;
let lanPollTimer = null;

// ===== TABS =====
function switchTab(name, event) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'lan') loadLan();
}

// ===== POSTS =====
async function loadPosts() {
  try {
    postsState = await fetch('/api/posts').then(r => r.json());
    renderPosts();
  } catch(e) { showToast('Failed to load posts', 'err'); }
}

function renderPosts() {
  const list = document.getElementById('post-list');
  document.getElementById('post-count').textContent = postsState.length + ' posts';
  if (!postsState.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px">No posts yet. Click + New post to create one.</div>'; return; }
  list.innerHTML = postsState.map(post => {
    const badge = post.published ? '<span class="badge-pub">Published</span>' : '<span class="badge-draft">Draft</span>';
    return '<div class="post-row">' +
      '<div class="post-row-header">' +
        '<div class="post-title">' + esc(post.title) + '</div>' +
        badge +
        '<span class="post-date">' + esc(post.date || '') + '</span>' +
      '</div>' +
      (post.excerpt ? '<div class="post-excerpt">' + esc(post.excerpt) + '</div>' : '') +
      '<div class="post-actions">' +
        '<button class="btn btn-secondary btn-sm" onclick="openEditModal(' + esc(JSON.stringify(post.id)) + ')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="togglePublished(' + esc(JSON.stringify(post.id)) + ')">' + (post.published ? 'Unpublish' : 'Publish') + '</button>' +
        '<button class="btn btn-danger" onclick="deletePost(' + esc(JSON.stringify(post.id)) + ')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openNewPostModal() {
  _editMode = 'create';
  document.getElementById('modal-title').textContent = 'New Post';
  document.getElementById('edit-id').value = '';
  document.getElementById('edit-title').value = '';
  document.getElementById('edit-slug').value = '';
  document.getElementById('edit-excerpt').value = '';
  document.getElementById('edit-content').value = '';
  document.getElementById('edit-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('edit-published').checked = false;
  document.getElementById('edit-modal').classList.add('open');
}

function openEditModal(id) {
  const post = postsState.find(p => p.id === id);
  if (!post) return;
  _editMode = 'edit';
  document.getElementById('modal-title').textContent = 'Edit Post';
  document.getElementById('edit-id').value = post.id;
  document.getElementById('edit-title').value = post.title || '';
  document.getElementById('edit-slug').value = post.slug || '';
  document.getElementById('edit-excerpt').value = post.excerpt || '';
  document.getElementById('edit-content').value = post.content || '';
  document.getElementById('edit-date').value = post.date || '';
  document.getElementById('edit-published').checked = !!post.published;
  document.getElementById('edit-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('edit-modal').classList.remove('open');
}

async function savePost() {
  const title = document.getElementById('edit-title').value.trim();
  if (!title) { showToast('Title is required', 'err'); return; }
  const data = {
    id: document.getElementById('edit-id').value || undefined,
    title,
    slug: document.getElementById('edit-slug').value.trim() || undefined,
    excerpt: document.getElementById('edit-excerpt').value.trim(),
    content: document.getElementById('edit-content').value,
    date: document.getElementById('edit-date').value,
    published: document.getElementById('edit-published').checked,
  };
  try {
    if (_editMode === 'create') {
      await fetch('/api/posts/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    } else {
      await fetch('/api/posts/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    closeModal();
    await loadPosts();
    showToast('Saved ✓', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'err'); }
}

async function togglePublished(id) {
  const post = postsState.find(p => p.id === id);
  if (!post) return;
  try {
    await fetch('/api/posts/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, published: !post.published }) });
    await loadPosts();
    showToast((post.published ? 'Unpublished' : 'Published') + ' ✓', 'ok');
  } catch(e) { showToast('Failed', 'err'); }
}

async function deletePost(id) {
  const post = postsState.find(p => p.id === id);
  if (!confirm('Delete "' + (post?.title || id) + '"?')) return;
  try {
    await fetch('/api/posts', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    await loadPosts();
    showToast('Deleted ✓', 'ok');
  } catch(e) { showToast('Delete failed', 'err'); }
}

// ===== DEPLOY =====
async function runDeploy() {
  const box = document.getElementById('deploy-progress');
  box.innerHTML = '';
  box.classList.add('active');
  const es = new EventSource('/api/deploy');
  es.onmessage = e => {
    if (e.data.startsWith('__DONE__')) { es.close(); const d = document.createElement('div'); d.style.color = 'var(--green)'; d.textContent = 'Done ✓'; box.appendChild(d); return; }
    if (e.data.trim()) { const d = document.createElement('div'); d.textContent = e.data; if (e.data.startsWith('❌')) d.style.color = 'var(--red)'; else if (e.data.startsWith('✓')) d.style.color = 'var(--green)'; box.appendChild(d); box.scrollTop = box.scrollHeight; }
  };
}

// ===== LAN =====
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
    btn.textContent = '🟢 ON'; btn.className = 'btn btn-ghost';
    text.textContent = 'Accepting requests from LAN devices';
    urlSection.style.display = '';
    const urls = (lanIps || []).map(ip => location.protocol + '//' + ip + ':' + ADMIN_PORT + '/pair?invite=' + (_inviteCode || ''));
    document.getElementById('pair-url-list').innerHTML = urls.map(u =>
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><code style="background:var(--bg3);padding:4px 10px;border-radius:4px;font-size:12px;flex:1;word-break:break-all">' + esc(u) + '</code><button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(' + esc(JSON.stringify(u)) + ')">Copy</button></div>'
    ).join('') || '<div style="color:var(--muted);font-size:13px">No LAN IPs detected</div>';
  } else {
    btn.textContent = '⚫ OFF'; btn.className = 'btn btn-secondary';
    text.textContent = 'LAN sharing is off';
    urlSection.style.display = 'none';
  }
}

async function toggleSharing() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  const resp = await fetch('/api/pair/sharing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !_sharingEnabled }) });
  if (resp.ok) { const d = await resp.json(); _sharingEnabled = d.enabled; _inviteCode = d.inviteCode ?? null; renderSharingState(cfg.lan || []); }
}

async function loadPending() {
  let list; try { list = await fetch('/api/pair/pending').then(r => r.json()); } catch { return; }
  const el = document.getElementById('pending-list');
  const badge = document.getElementById('pending-badge');
  if (!list.length) { badge.textContent = ''; el.innerHTML = '<div style="color:var(--muted);font-size:13px">No pending requests</div>'; return; }
  badge.textContent = '(' + list.length + ')';
  el.innerHTML = list.map(p =>
    '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:8px">' +
      '<div style="flex:1"><div style="font-size:13px;font-weight:500">' + esc(p.peerIp) + '</div><div style="font-size:28px;font-weight:700;letter-spacing:8px;color:#fff;margin:4px 0">' + esc(p.code) + '</div><div style="font-size:11px;color:var(--muted)">' + p.expiresIn + 's</div></div>' +
      '<button class="btn btn-primary btn-sm" onclick="pairApprove(' + esc(JSON.stringify(p.code)) + ')">Approve</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="pairReject(' + esc(JSON.stringify(p.code)) + ')">Reject</button>' +
    '</div>'
  ).join('');
}

async function pairApprove(code) { await fetch('/api/pair/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); loadPending(); }
async function pairReject(code) { await fetch('/api/pair/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); loadPending(); }

// ===== UTILS =====
// All user-supplied strings pass through esc() before innerHTML — this is the XSS guard.
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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

// Close modal on background click
document.getElementById('edit-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

loadPosts();
</script>
</body>
</html>`;
}
