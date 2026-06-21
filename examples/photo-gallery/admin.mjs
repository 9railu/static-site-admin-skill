/**
 * admin.mjs — Photo gallery manager example
 *
 * Manages a VRChat-style photo gallery with:
 * - WebP thumbnail/full conversion via sharp (npm install sharp)
 * - XMP metadata extraction (world ID, world name) from VRChat PNG files
 * - Hero image slot management
 * - SSE deploy pipeline
 *
 * Data: assets/photos.json  (array of photo metadata)
 *       public/assets/hero-config.json  (hero image slots)
 * Files: public/assets/thumb/  (WebP thumbnails, 400px wide)
 *        public/assets/full/   (WebP full-size, 1920px wide)
 *
 * Usage: node scripts/admin.mjs
 * Requires: npm install sharp  (only external dependency, for image conversion)
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
const PHOTOS_JSON = path.join(ROOT, 'assets', 'photos.json');
const HERO_CONFIG = path.join(ROOT, 'public', 'assets', 'hero-config.json');
const THUMB_DIR = path.join(ROOT, 'public', 'assets', 'thumb');
const FULL_DIR  = path.join(ROOT, 'public', 'assets', 'full');
const ASSETS_DIR = path.join(ROOT, 'public', 'assets');
const PRODUCTION_URL = '';  // e.g. 'https://your-site.com'
const DEFAULT_AUTHOR = 'Your Name';
const GIT_ADD_PATHS = ['assets/photos.json', 'public/assets'];

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

const MAX_BODY = 50 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => { total += c.length; if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => { total += c.length; if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

function serveFileSafe(baseDir, rawSegment, res) {
  if (rawSegment.includes('..') || rawSegment.includes('\\')) return sendError(res, 403, 'Forbidden');
  const decoded = decodeURIComponent(rawSegment);
  const resolved = path.resolve(baseDir, decoded);
  const base = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : baseDir;
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return sendError(res, 403, 'Forbidden');
  if (!fs.existsSync(resolved)) return sendError(res, 404, 'Not found');
  const ext = path.extname(resolved).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
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

// ---- VRChat helpers ----

function parseVRChatFilename(filename) {
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
  const resMatch = filename.match(/(\d+)x(\d+)/);
  const result = {};
  if (dateMatch) result.createDate = dateMatch[1] + 'T' + dateMatch[2].replace(/-/g, ':');
  if (resMatch) {
    result.width = parseInt(resMatch[1]);
    result.height = parseInt(resMatch[2]);
    result.orientation = result.height > result.width ? 'portrait' : result.width > result.height ? 'landscape' : 'square';
  }
  return result;
}

async function extractXMPMeta(filepath) {
  try {
    const buf = await fs.promises.readFile(filepath);
    const text = buf.slice(0, Math.min(buf.length, 512 * 1024)).toString('utf8');
    const between = (open, close) => {
      const s = text.indexOf(open);
      if (s === -1) return null;
      const vs = s + open.length;
      const e = text.indexOf(close, vs);
      return e === -1 ? null : text.slice(vs, e).trim();
    };
    return {
      worldId: between('<vrc:WorldID>', '</vrc:WorldID>')?.replace(/\s/g, '') || null,
      worldName: between('<vrc:WorldDisplayName>', '</vrc:WorldDisplayName>') || null,
      author: between('<xmp:Author>', '</xmp:Author>') || null,
    };
  } catch {
    return { worldId: null, worldName: null, author: null };
  }
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

// ---- PHOTO HANDLERS ----

function handleGetPhotos(res) {
  try {
    sendJSON(res, fs.existsSync(PHOTOS_JSON) ? JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf8')) : []);
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePostPhotos(req, res) {
  try {
    const photos = JSON.parse(await readBody(req));
    fs.mkdirSync(path.dirname(PHOTOS_JSON), { recursive: true });
    fs.writeFileSync(PHOTOS_JSON, JSON.stringify(photos, null, 2), 'utf8');
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleDeletePhoto(req, res) {
  try {
    const { filename } = JSON.parse(await readBody(req));
    if (!filename || /[/\\]/.test(filename)) return sendError(res, 400, 'Invalid filename');
    const photos = JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf8'));
    const next = photos.filter(p => p.filename !== filename);
    if (next.length === photos.length) return sendError(res, 404, 'Not found');
    fs.writeFileSync(PHOTOS_JSON, JSON.stringify(next, null, 2), 'utf8');
    const base = filename.replace(/\.(png|jpg|jpeg)$/i, '');
    for (const fp of [path.join(ASSETS_DIR, filename), path.join(THUMB_DIR, base + '.webp'), path.join(FULL_DIR, base + '.webp')]) {
      try { fs.unlinkSync(fp); } catch (_) {}
    }
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleUploadPhotos(req, res) {
  try {
    const body = await readRawBody(req);
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return sendError(res, 400, 'No boundary');
    const parts = parseMultipart(body, bm[1].trim()).filter(p => p.filename);
    if (!parts.length) return sendError(res, 400, 'No files');

    const { default: sharp } = await import('sharp');
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    fs.mkdirSync(FULL_DIR, { recursive: true });

    const existing = new Set(
      fs.existsSync(PHOTOS_JSON) ? JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf8')).map(p => p.filename) : []
    );
    const results = [];

    for (const part of parts) {
      const filename = path.basename(part.filename);
      if (!/\.(png|jpg|jpeg)$/i.test(filename)) continue;
      const destPath = path.join(ASSETS_DIR, filename);
      fs.writeFileSync(destPath, part.body);
      const base = filename.replace(/\.(png|jpg|jpeg)$/i, '');
      await sharp(destPath).resize(400, null, { withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(THUMB_DIR, base + '.webp'));
      await sharp(destPath).resize(1920, null, { withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(FULL_DIR, base + '.webp'));
      const fileMeta = parseVRChatFilename(filename);
      const xmpMeta = await extractXMPMeta(destPath);
      if (!fileMeta.width || !fileMeta.height) {
        const meta = await sharp(destPath).metadata();
        fileMeta.width = meta.width;
        fileMeta.height = meta.height;
        fileMeta.orientation = meta.height > meta.width ? 'portrait' : meta.width > meta.height ? 'landscape' : 'square';
      }
      results.push({
        filename,
        alreadyExists: existing.has(filename),
        ...fileMeta,
        worldId: xmpMeta.worldId || null,
        worldName: xmpMeta.worldName || null,
        worldUrl: xmpMeta.worldId ? 'https://vrchat.com/home/world/' + xmpMeta.worldId : null,
        author: xmpMeta.author || DEFAULT_AUTHOR,
      });
    }
    sendJSON(res, results);
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleScanPhotos(res) {
  try {
    const existing = new Set(
      fs.existsSync(PHOTOS_JSON) ? JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf8')).map(p => p.filename) : []
    );
    const newFiles = fs.readdirSync(ASSETS_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f) && !existing.has(f) && !f.toLowerCase().startsWith('hero-'));
    const results = await Promise.all(newFiles.map(async filename => {
      const fileMeta = parseVRChatFilename(filename);
      const xmpMeta = await extractXMPMeta(path.join(ASSETS_DIR, filename));
      return {
        filename, ...fileMeta,
        worldId: xmpMeta.worldId || null,
        worldName: xmpMeta.worldName || null,
        worldUrl: xmpMeta.worldId ? 'https://vrchat.com/home/world/' + xmpMeta.worldId : null,
        author: xmpMeta.author || DEFAULT_AUTHOR,
      };
    }));
    sendJSON(res, results);
  } catch (e) { sendError(res, 500, e.message); }
}

// ---- HERO HANDLERS ----

function handleGetHero(res) {
  try {
    if (!fs.existsSync(HERO_CONFIG)) {
      return sendJSON(res, [
        { src: '/assets/hero-1.jpg', focus: { landscape: [0.5, 0.2], square: [0.5, 0.25], portrait: [0.5, 0.3] } },
      ]);
    }
    sendJSON(res, JSON.parse(fs.readFileSync(HERO_CONFIG, 'utf8')));
  } catch (e) { sendError(res, 500, e.message); }
}

async function handlePostHero(req, res) {
  try {
    const hero = JSON.parse(await readBody(req));
    fs.mkdirSync(path.dirname(HERO_CONFIG), { recursive: true });
    fs.writeFileSync(HERO_CONFIG, JSON.stringify(hero, null, 2), 'utf8');
    sendJSON(res, { ok: true });
  } catch (e) { sendError(res, 500, e.message); }
}

async function handleUploadHero(req, res) {
  try {
    const body = await readRawBody(req);
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return sendError(res, 400, 'No boundary');
    const parts = parseMultipart(body, bm[1].trim());
    const filePart = parts.find(p => p.filename);
    const indexPart = parts.find(p => p.name === 'index');
    if (!filePart) return sendError(res, 400, 'No file');
    const slotIndex = parseInt(indexPart?.body.toString('utf8') || '0');
    const ext = path.extname(filePart.filename).toLowerCase() || '.jpg';
    const destName = 'hero-' + (slotIndex + 1) + ext;
    const destPath = path.join(ASSETS_DIR, destName);
    fs.writeFileSync(destPath, filePart.body);
    const { default: sharp } = await import('sharp');
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    fs.mkdirSync(FULL_DIR, { recursive: true });
    await sharp(destPath).resize(800, null, { withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(THUMB_DIR, 'hero-' + (slotIndex + 1) + '.webp'));
    await sharp(destPath).resize(1920, null, { withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(FULL_DIR, 'hero-' + (slotIndex + 1) + '.webp'));
    sendJSON(res, { ok: true, src: '/assets/' + destName });
  } catch (e) { sendError(res, 500, e.message); }
}

// ---- DEPLOY ----

async function handleDeploy(req, res) {
  startSSE(res);
  const date = new Date().toISOString().slice(0, 10);
  const buildCmd = process.platform === 'win32' ? 'cmd' : 'npm';
  const buildArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', 'build'] : ['run', 'build'];
  const buildCode = await sseStep(res, 'npm run build', buildCmd, buildArgs);
  if (buildCode !== 0) { res.write('data: ❌ Build failed\n\ndata: __DONE__\n\n'); return res.end(); }
  res.write('data: ✓ Build complete\n\n');
  const filesToAdd = [...GIT_ADD_PATHS];
  if (fs.existsSync(HERO_CONFIG)) filesToAdd.push('public/assets/hero-config.json');
  await sseStep(res, 'git add', 'git', ['add', ...filesToAdd]);
  const commitCode = await sseStep(res, 'git commit', 'git', ['commit', '-m', 'update: photos & hero [' + date + ']']);
  if (commitCode !== 0) { res.write('data: ℹ Nothing to commit\n\ndata: __DONE__\n\n'); return res.end(); }
  res.write('data: ✓ Committed\n\n');
  const pushCode = await sseStep(res, 'git push', 'git', ['push']);
  res.write(pushCode !== 0 ? 'data: ❌ Push failed\n\n' : 'data: ✓ Pushed' + (PRODUCTION_URL ? ' — ' + PRODUCTION_URL : '') + '\n\n');
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

  if (method === 'GET'  && p === '/')                   return sendHTML(res, getAdminHTML());
  if (method === 'GET'  && p === '/api/config')         return sendJSON(res, { port: PORT, lan: getLanAddresses(), pairingEnabled, inviteCode, productionUrl: PRODUCTION_URL });
  if (method === 'GET'  && p === '/api/photos')         return handleGetPhotos(res);
  if (method === 'POST' && p === '/api/photos')         return handlePostPhotos(req, res);
  if (method === 'DELETE' && p === '/api/photos')       return handleDeletePhoto(req, res);
  if (method === 'GET'  && p === '/api/hero')           return handleGetHero(res);
  if (method === 'POST' && p === '/api/hero')           return handlePostHero(req, res);
  if (method === 'GET'  && p === '/api/scan-photos')    return handleScanPhotos(res);
  if (method === 'POST' && p === '/api/upload-photos')  return handleUploadPhotos(req, res);
  if (method === 'POST' && p === '/api/upload-hero')    return handleUploadHero(req, res);
  if (method === 'GET'  && p === '/api/deploy')         return handleDeploy(req, res);
  if (method === 'GET'  && p.startsWith('/thumb/'))     return serveFileSafe(THUMB_DIR, p.slice(7), res);
  if (method === 'GET'  && p.startsWith('/assets/'))    return serveFileSafe(ASSETS_DIR, p.slice(8), res);

  if (p.startsWith('/api/pair/') && !isLocalhost) return sendError(res, 403, 'Host only');
  if (method === 'GET'  && p === '/api/pair/pending')   return handlePairPending(res);
  if (method === 'POST' && p === '/api/pair/approve')   return handlePairApprove(req, res);
  if (method === 'POST' && p === '/api/pair/reject')    return handlePairReject(req, res);
  if (method === 'POST' && p === '/api/pair/sharing')   return handlePairSharing(req, res);

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
  console.log('\x1b[32mPhoto admin running\x1b[0m  ' + localUrl);
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
button{background:#3050a0;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-size:14px;cursor:pointer;margin-top:8px}button:disabled{opacity:.5}</style></head>
<body><div class="box"><h1>Access Request</h1><p class="sub">Show the code to the host</p>
<div id="main"><button id="req-btn" onclick="requestCode()">Request access</button></div>
<div class="status" id="status"></div></div>
<script>
let pt=null;
async function requestCode(){
  document.getElementById('req-btn').disabled=true;
  document.getElementById('status').textContent='Requesting...';
  try{
    const r=await fetch('/api/pair/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:'${invite}'})});
    const d=await r.json();
    document.getElementById('main').innerHTML='<div class="code">'+d.code+'</div><p style="font-size:12px;color:#6a6a7a">Expires in '+Math.floor(d.expiresIn/60)+' min</p>';
    document.getElementById('status').textContent='Waiting for approval...';
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
<title>Photo Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0b14;--bg2:#12141f;--bg3:#1a1d2e;--text:#c8c8d0;--muted:#6a6a7a;--accent:#3050a0;--accent2:#4060c0;--border:#2a2d3e;--green:#2a8a4a;--yellow:#a07020;--red:#c05050}
body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px;min-height:100vh;padding-bottom:68px}
button{cursor:pointer;font:inherit;border:none;outline:none}
input,select,textarea{font:inherit;background:var(--bg3);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:4px;width:100%}
input:focus,select:focus{border-color:var(--accent2);outline:none}
.admin-header{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:32px;height:56px;position:sticky;top:0;z-index:100}
.admin-header h1{font-size:16px;font-weight:600}
.tabs{display:flex}
.tab-btn{padding:0 20px;height:56px;background:none;color:var(--muted);font-size:14px;border-bottom:2px solid transparent;transition:all .2s}
.tab-btn.active{color:var(--text);border-bottom-color:var(--accent2)}.tab-btn:hover:not(.active){color:var(--text)}
.tab-content{display:none;padding:24px}.tab-content.active{display:block}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
.section-title{font-size:15px;font-weight:600;margin-bottom:16px}
.section-note{font-size:12px;color:var(--muted);margin-bottom:12px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;transition:all .15s;border:none;cursor:pointer}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent2)}
.btn-secondary{background:var(--bg3);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--muted)}
.btn-ghost{background:none;color:var(--muted);padding:4px 8px}.btn-ghost:hover{color:var(--text)}
.btn-danger{background:none;color:var(--red);border:1px solid var(--red);padding:4px 10px;font-size:12px}.btn-danger:hover{background:var(--red);color:#fff}
.btn-sm{padding:5px 10px;font-size:12px}
.fixed-bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg2);border-top:1px solid var(--border);padding:10px 24px;display:flex;align-items:center;gap:10px;z-index:200}
.dirty-badge{font-size:12px;color:var(--yellow);display:none}.dirty-badge.show{display:inline}
.toast{position:fixed;bottom:76px;left:50%;transform:translateX(-50%) translateY(12px);background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 20px;font-size:13px;z-index:300;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}.toast.ok{border-color:var(--green);color:var(--green)}.toast.err{border-color:var(--red);color:var(--red)}
.progress-box{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-top:12px;font-size:12px;color:var(--muted);max-height:160px;overflow-y:auto;display:none}
.progress-box.active{display:block}
/* World groups */
.world-group{border:1px solid var(--border);border-radius:6px;margin-bottom:12px;overflow:hidden}
.world-group-header{background:var(--bg3);padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);cursor:pointer}
.world-group-name{flex:1;font-size:13px;font-weight:500}
.world-group-count{font-size:11px;color:var(--muted)}
.collapse-icon{font-size:10px;color:var(--muted);transition:transform .15s}
.world-group.collapsed .collapse-icon{transform:rotate(-90deg)}
.world-group.collapsed .world-group-photos{display:none}
.world-group-photos{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px}
/* Photo cards */
.photo-card{position:relative;cursor:zoom-in}
.photo-card img{width:88px;height:88px;object-fit:cover;border-radius:4px;display:block;border:2px solid transparent;transition:border-color .15s}
.photo-card img:hover{border-color:var(--muted)}
.photo-card.hidden-photo img{opacity:.3;border-color:var(--red)}
.photo-overlay{position:absolute;inset:0;border-radius:4px;display:flex;flex-direction:column;justify-content:space-between;padding:3px;opacity:0;transition:opacity .15s;pointer-events:none}
.photo-card:hover .photo-overlay{opacity:1;background:rgba(0,0,0,.15)}
.photo-overlay .photo-btn{pointer-events:auto}
.photo-overlay-top{display:flex;justify-content:flex-end}.photo-overlay-bottom{display:flex;justify-content:space-between}
.photo-btn{background:rgba(0,0,0,.72);border:none;border-radius:3px;color:#fff;font-size:11px;padding:2px 5px;cursor:pointer;white-space:nowrap}
.photo-btn:hover{background:rgba(255,255,255,.15)}.photo-btn.del{background:rgba(140,30,30,.85)}.photo-btn.del:hover{background:rgba(180,40,40,.9)}
/* Scan */
.scan-card{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:10px}
.scan-card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.scan-thumb{width:60px;height:60px;object-fit:cover;border-radius:4px;flex-shrink:0}
.scan-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.scan-field label{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}
.scan-actions{margin-top:10px;display:flex;gap:8px}
/* Lightbox */
.lb-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:500;display:none;flex-direction:column;align-items:center;justify-content:center}
.lb-backdrop.open{display:flex}
.lb-img-wrap img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:4px;display:block}
.lb-close{position:fixed;top:16px;right:20px;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:20px;width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:501}
.lb-arrow{position:fixed;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:22px;width:44px;height:44px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:501}
.lb-prev{left:12px}.lb-next{right:12px}.lb-arrow[disabled]{opacity:.25;pointer-events:none}
.lb-info{color:rgba(255,255,255,.55);font-size:12px;margin-top:10px;text-align:center;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<div class="admin-header">
  <h1>Photo Admin</h1>
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('photos',event)">Photos</button>
    <button class="tab-btn" onclick="switchTab('lan',event)">LAN Access</button>
  </div>
</div>

<div class="tab-content active" id="tab-photos">
  <div class="section">
    <div class="section-title">Add photos</div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
      <button class="btn btn-primary" onclick="document.getElementById('photo-file-input').click()">&#128193; Upload</button>
      <input type="file" id="photo-file-input" multiple accept="image/png,image/jpeg" style="display:none" onchange="uploadPhotos(this.files)">
      <span style="color:var(--muted);font-size:12px">or</span>
      <button class="btn btn-secondary" onclick="scanPhotos()">&#128194; Scan assets/</button>
    </div>
    <div class="section-note">Upload: PNG/JPG → WebP conversion + XMP metadata extraction</div>
    <div id="scan-results" style="margin-top:14px"></div>
  </div>

  <div class="section">
    <div class="section-title">Manage photos <span id="photos-count" style="font-size:12px;font-weight:400;color:var(--muted)"></span></div>
    <div id="world-list"></div>
    <div class="progress-box" id="deploy-progress"></div>
  </div>
</div>

<div class="tab-content" id="tab-lan">
  <div class="section" id="pair-host-section" style="display:none">
    <div class="section-title">LAN Sharing</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <button id="sharing-toggle-btn" class="btn btn-secondary" onclick="toggleSharing()">⚫ OFF</button>
      <span id="sharing-status-text" style="font-size:13px;color:var(--muted)"></span>
    </div>
    <div id="pair-url-section" style="display:none"><div id="pair-url-list"></div></div>
  </div>
  <div class="section" id="pending-section" style="display:none">
    <div class="section-title">Pending <span id="pending-badge" style="font-size:12px;font-weight:400;color:var(--muted)"></span></div>
    <div id="pending-list"><div style="color:var(--muted);font-size:13px">No pending requests</div></div>
  </div>
</div>

<div class="fixed-bar">
  <button class="btn btn-primary" onclick="savePhotos()">&#128190; Save</button>
  <button class="btn btn-secondary" onclick="deployAll()">&#128640; Deploy</button>
  <span class="dirty-badge" id="dirty-badge">● Unsaved changes</span>
</div>

<!-- Lightbox -->
<div class="lb-backdrop" id="lb" onclick="lbBgClick(event)">
  <button class="lb-close" onclick="closeLb()">✕</button>
  <button class="lb-arrow lb-prev" id="lb-prev" onclick="navigateLb(-1)">‹</button>
  <div class="lb-img-wrap"><img id="lb-img" src="" alt=""></div>
  <button class="lb-arrow lb-next" id="lb-next" onclick="navigateLb(1)">›</button>
  <div class="lb-info" id="lb-info"></div>
</div>

<script>
const ADMIN_PORT = ${PORT};
let photosState = [];
let worldOrder = [];
let productionUrl = '${PRODUCTION_URL}';
let _sharingEnabled = false;
let _inviteCode = null;
let lanPollTimer = null;
const collapsedGroups = new Set();
let _lbList = [], _lbIdx = 0;

// ===== TABS =====
function switchTab(name, event) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'lan') loadLan();
}

// ===== PHOTOS =====
async function loadPhotos() {
  photosState = await fetch('/api/photos').then(r => r.json());
  buildWorldOrder();
  renderWorldList();
}

function thumbUrl(filename) {
  const webp = filename.replace(/\\.(png|jpg|jpeg)$/i, '.webp');
  return productionUrl ? productionUrl + '/assets/thumb/' + webp : '/thumb/' + webp;
}

function buildWorldOrder() {
  const seen = new Set();
  worldOrder = [];
  photosState.forEach(p => {
    const key = p.worldId || '__none__';
    if (!seen.has(key)) { seen.add(key); worldOrder.push(key); }
  });
}

function getWorldMap() {
  const map = {};
  photosState.forEach(p => {
    const key = p.worldId || '__none__';
    if (!map[key]) map[key] = { name: p.worldName || '(unknown world)', url: p.worldUrl, photos: [] };
    map[key].photos.push(p);
  });
  return map;
}

function renderWorldList() {
  const map = getWorldMap();
  const total = photosState.length;
  const visible = photosState.filter(p => !p.hidden).length;
  document.getElementById('photos-count').textContent = total + ' total / ' + visible + ' visible';
  const container = document.getElementById('world-list');
  container.innerHTML = '';
  worldOrder.forEach((wid, idx) => {
    const world = map[wid];
    if (!world) return;
    const allHidden = world.photos.every(p => p.hidden);
    const hiddenCount = world.photos.filter(p => p.hidden).length;
    const isCollapsed = collapsedGroups.has(wid);
    const el = document.createElement('div');
    el.className = 'world-group' + (isCollapsed ? ' collapsed' : '');
    el.dataset.wid = wid;
    const photos = world.photos.map(p => {
      const thumb = thumbUrl(p.filename);
      const rot = p.rotation || 0;
      const jfn = esc(JSON.stringify(p.filename));
      return '<div class="photo-card' + (p.hidden ? ' hidden-photo' : '') + '" title="' + esc(p.filename) + '" onclick="openLb(' + jfn + ')">' +
        '<img src="' + esc(thumb) + '" loading="lazy" onerror="this.style.background=\\'#333\\'" style="transform:rotate(' + rot + 'deg)">' +
        '<div class="photo-overlay">' +
          '<div class="photo-overlay-top"><button class="photo-btn" onclick="event.stopPropagation();togglePhoto(' + jfn + ')">' + (p.hidden ? '👁 Show' : '🚫 Hide') + '</button></div>' +
          '<div class="photo-overlay-bottom"><button class="photo-btn del" onclick="event.stopPropagation();deletePhoto(' + jfn + ')">🗑</button><button class="photo-btn" onclick="event.stopPropagation();rotatePhoto(' + jfn + ')">↻ ' + rot + '°</button></div>' +
        '</div>' +
      '</div>';
    }).join('');
    el.innerHTML =
      '<div class="world-group-header" onclick="collapseGroup(' + esc(JSON.stringify(wid)) + ')">' +
        '<span class="collapse-icon">▾</span>' +
        '<div class="world-group-name" style="margin-left:6px">' + esc(world.name) + '</div>' +
        '<span class="world-group-count">' + world.photos.length + (hiddenCount ? ' (' + hiddenCount + ' hidden)' : '') + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();toggleGroup(' + esc(JSON.stringify(wid)) + ')">' + (allHidden ? 'Show all' : 'Hide all') + '</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();moveGroup(' + esc(JSON.stringify(wid)) + ',-1)" ' + (idx === 0 ? 'disabled' : '') + '>↑</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();moveGroup(' + esc(JSON.stringify(wid)) + ',1)" ' + (idx === worldOrder.length - 1 ? 'disabled' : '') + '>↓</button>' +
      '</div>' +
      '<div class="world-group-photos">' + photos + '</div>';
    container.appendChild(el);
  });
}

function collapseGroup(wid) { if (collapsedGroups.has(wid)) collapsedGroups.delete(wid); else collapsedGroups.add(wid); renderWorldList(); }
function togglePhoto(filename) { const p = photosState.find(x => x.filename === filename); if (p) { p.hidden = !p.hidden; markDirty(); } renderWorldList(); }
function rotatePhoto(filename) { const p = photosState.find(x => x.filename === filename); if (p) { p.rotation = ((p.rotation || 0) + 90) % 360; markDirty(); } renderWorldList(); }
function toggleGroup(wid) { const map = getWorldMap(); const world = map[wid]; if (!world) return; const allHidden = world.photos.every(p => p.hidden); world.photos.forEach(p => p.hidden = !allHidden); markDirty(); renderWorldList(); }
function moveGroup(wid, dir) { const idx = worldOrder.indexOf(wid); if (idx === -1) return; const ni = idx + dir; if (ni < 0 || ni >= worldOrder.length) return; [worldOrder[idx], worldOrder[ni]] = [worldOrder[ni], worldOrder[idx]]; markDirty(); renderWorldList(); }

async function deletePhoto(filename) {
  if (!confirm(filename + '\\n\\nDelete this photo? (JSON entry + thumb + full will be removed)')) return;
  const r = await fetch('/api/photos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
  if (r.ok) { photosState = photosState.filter(p => p.filename !== filename); buildWorldOrder(); renderWorldList(); showToast('Deleted ✓', 'ok'); }
  else showToast('Delete failed', 'err');
}

async function savePhotos() {
  const map = getWorldMap();
  const reordered = [];
  worldOrder.forEach(wid => { const w = map[wid]; if (w) w.photos.forEach(p => reordered.push(p)); });
  try {
    await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reordered) });
    photosState = reordered;
    markClean();
    showToast('Saved ✓', 'ok');
  } catch(e) { showToast('Save failed: ' + e.message, 'err'); }
}

async function deployAll() {
  await savePhotos();
  const box = document.getElementById('deploy-progress');
  box.innerHTML = '';
  box.classList.add('active');
  const es = new EventSource('/api/deploy');
  es.onmessage = e => {
    if (e.data.startsWith('__DONE__')) { es.close(); const d = document.createElement('div'); d.style.color = 'var(--green)'; d.textContent = 'Done ✓'; box.appendChild(d); box.scrollTop = box.scrollHeight; return; }
    if (e.data.trim()) { const d = document.createElement('div'); d.textContent = e.data; if (e.data.startsWith('❌')) d.style.color = 'var(--red)'; else if (e.data.startsWith('✓')) d.style.color = 'var(--green)'; box.appendChild(d); box.scrollTop = box.scrollHeight; }
  };
}

// ===== UPLOAD =====
async function uploadPhotos(files) {
  if (!files || !files.length) return;
  const container = document.getElementById('scan-results');
  container.innerHTML = '<div style="color:var(--muted);font-size:13px">Uploading ' + files.length + ' file(s)...</div>';
  const fd = new FormData();
  for (const f of files) fd.append('photos', f, f.name);
  try {
    const resp = await fetch('/api/upload-photos', { method: 'POST', body: fd });
    if (!resp.ok) { container.innerHTML = '<div style="color:#f87;">Upload failed: ' + await resp.text() + '</div>'; return; }
    const results = await resp.json();
    document.getElementById('photo-file-input').value = '';
    if (!results.length) { container.innerHTML = '<div style="color:var(--muted);font-size:13px">No supported files found.</div>'; return; }
    window._scanData = results;
    renderScanResults(results);
  } catch(e) { container.innerHTML = '<div style="color:#f87;">Error: ' + e.message + '</div>'; }
}

async function scanPhotos() {
  const results = await fetch('/api/scan-photos').then(r => r.json());
  const container = document.getElementById('scan-results');
  if (!results.length) { container.innerHTML = '<div style="color:var(--muted);font-size:13px">No new photos found.</div>'; return; }
  window._scanData = results;
  renderScanResults(results);
}

function renderScanResults(results) {
  const fresh = results.filter(r => !r.alreadyExists);
  let html = '';
  if (fresh.length) html += '<div style="margin-bottom:12px"><button class="btn btn-primary btn-sm" onclick="addAllScanned()">Add all new (' + fresh.length + ')</button></div>';
  html += results.map((p, i) => {
    const thumb = '/thumb/' + p.filename.replace(/\\.(png|jpg|jpeg)$/i, '.webp');
    const badge = p.alreadyExists ? ' <span style="color:var(--yellow);font-size:11px">⚠ already exists</span>' : '';
    return '<div class="scan-card" id="scan-card-' + i + '">' +
      '<div class="scan-card-header"><img class="scan-thumb" src="' + esc(thumb) + '" onerror="this.style.background=\\'#333\\'"><div><div style="font-size:12px;font-weight:500">' + esc(p.filename) + badge + '</div><div style="font-size:11px;color:var(--muted)">' + esc(p.orientation || '') + ' · ' + esc((p.createDate || '').slice(0, 10)) + '</div></div></div>' +
      '<div class="scan-fields">' +
        '<div class="scan-field"><label>World name</label><input id="wn-' + i + '" value="' + esc(p.worldName || '') + '"></div>' +
        '<div class="scan-field"><label>World URL</label><input id="wu-' + i + '" value="' + esc(p.worldUrl || '') + '"></div>' +
        '<div class="scan-field"><label>World ID</label><input id="wi-' + i + '" value="' + esc(p.worldId || '') + '"></div>' +
        '<div class="scan-field"><label>Author</label><input id="wa-' + i + '" value="' + esc(p.author || '') + '"></div>' +
      '</div>' +
      '<div class="scan-actions"><button class="btn btn-primary btn-sm" onclick="addScanCard(' + i + ')">Add</button><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\\'scan-card-' + i + '\\').remove()">Skip</button></div>' +
    '</div>';
  }).join('');
  document.getElementById('scan-results').innerHTML = html;
}

async function addScanCard(i) {
  const p = window._scanData[i];
  photosState.push({
    filename: p.filename, width: p.width, height: p.height, orientation: p.orientation, createDate: p.createDate,
    worldId: document.getElementById('wi-' + i).value.trim() || null,
    worldName: document.getElementById('wn-' + i).value.trim() || null,
    worldUrl: document.getElementById('wu-' + i).value.trim() || null,
    author: document.getElementById('wa-' + i).value.trim() || '',
  });
  buildWorldOrder();
  await savePhotos();
  document.getElementById('scan-card-' + i)?.remove();
  renderWorldList();
}

async function addAllScanned() {
  (window._scanData || []).forEach((p, i) => {
    const card = document.getElementById('scan-card-' + i);
    if (!card) return;
    photosState.push({
      filename: p.filename, width: p.width, height: p.height, orientation: p.orientation, createDate: p.createDate,
      worldId: document.getElementById('wi-' + i)?.value.trim() || p.worldId || null,
      worldName: document.getElementById('wn-' + i)?.value.trim() || p.worldName || null,
      worldUrl: document.getElementById('wu-' + i)?.value.trim() || p.worldUrl || null,
      author: document.getElementById('wa-' + i)?.value.trim() || p.author || '',
    });
  });
  buildWorldOrder();
  await savePhotos();
  document.getElementById('scan-results').innerHTML = '<div style="color:var(--green);font-size:13px">Added ✓</div>';
  renderWorldList();
}

// ===== LIGHTBOX =====
function openLb(filename) { _lbList = photosState.map(p => p.filename); _lbIdx = _lbList.indexOf(filename); renderLb(); document.getElementById('lb').classList.add('open'); document.addEventListener('keydown', lbKeydown); }
function renderLb() { const fn = _lbList[_lbIdx]; const p = photosState.find(x => x.filename === fn); const img = document.getElementById('lb-img'); img.src = '/assets/full/' + fn.replace(/\\.(png|jpg|jpeg)$/i, '.webp'); img.style.transform = p?.rotation ? 'rotate(' + p.rotation + 'deg)' : ''; document.getElementById('lb-info').textContent = (p?.worldName ? p.worldName + ' — ' : '') + fn; document.getElementById('lb-prev').disabled = _lbIdx === 0; document.getElementById('lb-next').disabled = _lbIdx === _lbList.length - 1; }
function navigateLb(dir) { const n = _lbIdx + dir; if (n >= 0 && n < _lbList.length) { _lbIdx = n; renderLb(); } }
function closeLb() { document.getElementById('lb').classList.remove('open'); document.removeEventListener('keydown', lbKeydown); document.getElementById('lb-img').src = ''; }
function lbBgClick(e) { if (e.target === document.getElementById('lb')) closeLb(); }
function lbKeydown(e) { if (e.key === 'Escape') closeLb(); if (e.key === 'ArrowLeft') navigateLb(-1); if (e.key === 'ArrowRight') navigateLb(1); }

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
    text.textContent = 'Accepting requests';
    urlSection.style.display = '';
    const urls = (lanIps || []).map(ip => location.protocol + '//' + ip + ':' + ADMIN_PORT + '/pair?invite=' + (_inviteCode || ''));
    document.getElementById('pair-url-list').innerHTML = urls.map(u => '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><code style="background:var(--bg3);padding:4px 10px;border-radius:4px;font-size:12px;flex:1;word-break:break-all">' + esc(u) + '</code><button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(' + esc(JSON.stringify(u)) + ')">Copy</button></div>').join('') || '<div style="color:var(--muted);font-size:13px">No LAN IPs</div>';
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
      '<div style="flex:1"><div style="font-size:13px">' + esc(p.peerIp) + '</div><div style="font-size:28px;font-weight:700;letter-spacing:8px;color:#fff;margin:4px 0">' + esc(p.code) + '</div><div style="font-size:11px;color:var(--muted)">' + p.expiresIn + 's</div></div>' +
      '<button class="btn btn-primary btn-sm" onclick="pairApprove(' + esc(JSON.stringify(p.code)) + ')">Approve</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="pairReject(' + esc(JSON.stringify(p.code)) + ')">Reject</button>' +
    '</div>'
  ).join('');
}

async function pairApprove(code) { await fetch('/api/pair/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); loadPending(); }
async function pairReject(code) { await fetch('/api/pair/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}); loadPending(); }

// ===== UTILS =====
// All user-supplied strings pass through esc() before innerHTML — this is the XSS guard.
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
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

loadPhotos();
</script>
</body>
</html>`;
}
