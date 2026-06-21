# Customization Guide

Copy `template/admin.mjs` to your project's `scripts/` directory, then follow this guide.

## 1. Configuration constants (top of file)

```js
const PORT = 3099;                                    // change if port is in use
const ROOT = path.resolve(__dirname, '..');           // project root — adjust if scripts/ is nested deeper
const DATA_FILE = path.join(ROOT, 'data', 'items.json'); // your data file
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads'); // upload target dir
const PRODUCTION_URL = 'https://your-site.com';      // shown in console after deploy (optional)
const GIT_ADD_PATHS = ['data/items.json'];            // paths passed to git add on deploy
```

## 2. Data handlers

Replace the default `items` schema with your own. The pattern is always:

```js
// GET  /api/data    → return all items
// POST /api/data    → replace all items (save full array)
// DELETE /api/data  → delete one item by id
```

### Example: blog posts

```js
const POSTS_FILE = path.join(ROOT, 'data', 'posts.json');

function handleGetData(res) {
  sendJSON(res, JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')));
}

async function handlePostData(req, res) {
  const posts = JSON.parse(await readBody(req));
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2));
  sendJSON(res, { ok: true });
}

async function handleDeleteItem(req, res) {
  const { id } = JSON.parse(await readBody(req));
  const posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts.filter(p => p.id !== id), null, 2));
  sendJSON(res, { ok: true });
}
```

See `examples/blog-posts/admin.mjs` for a complete implementation with create/update/delete.

### Example: key-value settings

```js
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

function handleGetData(res) {
  const defaults = { title: '', description: '', theme: 'light' };
  const saved = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
  sendJSON(res, { ...defaults, ...saved });
}

async function handlePostData(req, res) {
  const settings = JSON.parse(await readBody(req));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  sendJSON(res, { ok: true });
}
```

## 3. File uploads

Add a multipart upload handler using the built-in `parseMultipart()` helper:

```js
async function handleUpload(req, res) {
  const body = await readRawBody(req);
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=(.+)/);
  if (!bm) return sendError(res, 400, 'No boundary');
  const parts = parseMultipart(body, bm[1].trim());
  const filePart = parts.find(p => p.filename);
  if (!filePart) return sendError(res, 400, 'No file');

  // Sanitize filename — never trust client-provided filenames
  const filename = path.basename(filePart.filename).replace(/[^\w.\-]/g, '_');
  if (!/\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(filename)) return sendError(res, 400, 'Invalid file type');

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), filePart.body);
  sendJSON(res, { ok: true, filename });
}
```

Register the route in the router:
```js
if (method === 'POST' && p === '/api/upload') return handleUpload(req, res);
```

## 4. Deploy pipeline

Adjust `GIT_ADD_PATHS` to include all files that change when you update content:

```js
// Only data file
const GIT_ADD_PATHS = ['data/posts.json'];

// Data + uploaded assets
const GIT_ADD_PATHS = ['data/posts.json', 'public/uploads'];

// Multiple data files
const GIT_ADD_PATHS = ['data/posts.json', 'data/settings.json', 'public/assets'];
```

**Use directory paths for new files.** If you do `git add data/posts.json` but `posts.json` is a newly created file, git won't include it. Use `git add data/` to catch new files:

```js
const GIT_ADD_PATHS = ['data'];  // catches any new files inside data/
```

## 5. Admin UI

The `getAdminHTML()` function returns the entire UI as a template literal string.

### Adding a new tab

```js
// In the HTML header:
'<button class="tab-btn" onclick="switchTab(\'settings\',event)">Settings</button>'

// Add the tab content div:
'<div class="tab-content" id="tab-settings">...</div>'

// The switchTab function handles the rest automatically
```

### Adding a new form field

```js
// In the "Add item" form:
'<div><label>Category</label><input id="new-category" placeholder="e.g. Technology"></div>'

// In the addItem() function:
const category = document.getElementById('new-category').value.trim();
dataState.push({ id, title, category, visible: true });
```

### Displaying items differently

The `renderItems()` function builds the list HTML. Replace it with whatever card/table layout you need. Remember to pass all dynamic strings through `esc()`:

```js
function renderItems() {
  const list = document.getElementById('item-list');
  list.innerHTML = dataState.map(item =>
    '<div class="item-row">' +
      '<div>' + esc(item.title) + '</div>' +      // ← esc() on all user data
      '<div>' + esc(item.category) + '</div>' +
      '<button onclick="deleteItem(' + esc(JSON.stringify(item.id)) + ')">Delete</button>' +
    '</div>'
  ).join('');
}
```

## 6. Adding custom API routes

Add routes in the router, after the CSRF check and before the 404:

```js
// Custom route example
if (method === 'GET' && p === '/api/stats')   return handleStats(res);
if (method === 'POST' && p === '/api/rebuild') return handleRebuild(req, res);
```

## 7. Disabling features you don't need

**No deploy pipeline:** Remove the `/api/deploy` route and `handleDeploy` function.

**No file uploads:** Remove `/api/upload` route, `handleUpload`, and `parseMultipart`.

**No LAN pairing:** Remove the `/pair`, `/api/pair/*` routes and all pairing state/handlers. Change the auth redirect to a simple 401.

**No HTTPS:** Replace `ensureCert()` with `const USE_HTTPS = false;` and remove the cert imports. (Not recommended if using LAN sharing.)

## Common patterns

### Auto-generate IDs

```js
const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
// → '1abc2def3a1b2c' — sortable by creation time, collision-resistant
```

### Slugify titles

```js
function slugify(title) {
  return title.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
}
```

### Serve images from a specific directory

```js
if (method === 'GET' && p.startsWith('/uploads/')) return serveFileSafe(UPLOADS_DIR, p.slice(9), res);
```

### SSE for long-running tasks

```js
async function handleBuildImages(req, res) {
  startSSE(res);
  // ... do work, streaming progress ...
  res.write('data: Step 1 complete\n\n');
  res.write('data: __DONE__\n\n');
  res.end();
}
```

Client-side:
```js
const es = new EventSource('/api/build-images');
es.onmessage = e => {
  if (e.data.startsWith('__DONE__')) { es.close(); return; }
  console.log(e.data);
};
```
