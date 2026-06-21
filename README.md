# static-site-admin

> Add a secure local admin UI to any static site — zero dependencies, single file.

A Node.js admin server you copy into your project. Works with Vite, Astro, SvelteKit, Next.js static export, or any static site generator. Runs only on your machine — never exposed to the internet.

## Features

- 🔒 **Zero npm dependencies** — Node.js built-ins only (`http`, `https`, `fs`, `crypto`, …)
- 📄 **Single file** — copy `template/admin.mjs` and run `node admin.mjs`
- 🔑 **Launch-token auth** — random token generated on startup, invalidated on restart
- 🛡️ **Auto HTTPS** — self-signed certificate generated automatically if `openssl` is available
- 📡 **LAN device pairing** — invite-URL + host-approval flow (TV-style 6-digit code)
- 🚫 **Private IP restriction** — blocks all internet traffic at the socket level
- 🔐 **CSRF protection** — `Sec-Fetch-Site` + `Origin` double-check
- 🚀 **SSE deploy pipeline** — `npm build → git add → commit → push` with live log streaming
- 📁 **Path-traversal-safe file serving** — upload handler and static file serving included

## Quick Start

```bash
# 1. Copy the template into your project
cp template/admin.mjs your-project/scripts/admin.mjs

# 2. Edit the CONFIGURATION section at the top of admin.mjs
#    (port, data file path, git paths for deploy, etc.)

# 3. Run
node your-project/scripts/admin.mjs
```

The terminal prints a `localhost` URL with an embedded token. Click it (or paste into browser) to log in.

> **Windows**: the browser opens automatically.

## Security

This server is designed to run locally and never be deployed. Its security model:

| Threat | Defence |
|--------|---------|
| Internet access | Socket-level private IP check (`req.socket.remoteAddress`) — not spoofable via `Host` header |
| Stolen URL | Launch token changes every restart; `HttpOnly` cookie prevents JS access |
| CSRF | `SameSite=Strict` cookie + `Sec-Fetch-Site` + `Origin` header checks |
| LAN eavesdropping | Auto HTTPS with self-signed cert covering all LAN IPs in SAN |
| Unauthorized LAN device | Invite URL (128-bit random) + host must approve each device individually |
| Path traversal | `path.resolve` + prefix check before serving any file |
| Large body attacks | 50 MB body limit, `req.destroy()` on overflow |

See [docs/security.md](docs/security.md) for full details.

## LAN Sharing

Share admin access with another device on the same network:

1. Open the **LAN Access** tab in the admin UI
2. Toggle sharing **ON** — an invite URL is generated
3. Send the invite URL to the other device
4. The device opens the URL, clicks "Request access", gets a 6-digit code
5. Back in your admin UI, approve the request — done

The other device gets its own session cookie tied to its IP. See [docs/lan-sharing.md](docs/lan-sharing.md).

## Customization

The template has clear `TODO` sections:

```
CONFIGURATION    — port, data file path, git paths
DATA HANDLERS    — replace the default items CRUD with your schema
DEPLOY PIPELINE  — adjust git add paths for your project
ADMIN UI         — customize the HTML/CSS/JS for your content type
```

See [docs/customization.md](docs/customization.md) for a step-by-step guide.

## Examples

| Example | Description |
|---------|-------------|
| [examples/blog-posts/](examples/blog-posts/) | Manage blog posts stored in JSON (title, content, date, published) |
| [examples/photo-gallery/](examples/photo-gallery/) | Photo gallery with WebP conversion and VRChat metadata extraction |

## Requirements

- Node.js 18+ (uses `fetch`, `crypto.randomInt`, top-level `await`)
- `openssl` (optional — for auto HTTPS; falls back to HTTP if not found)
- `git` (optional — only needed for the deploy feature)

## .gitignore

Add to your project's `.gitignore`:

```
scripts/server.key
scripts/server.crt
```

The self-signed certificate is auto-regenerated on next startup if missing.

## Claude Code Skill

This repository also ships as a **[Claude Code](https://claude.ai/code) skill** — install it to let Claude set up the admin server in any project automatically.

```bash
# Install the skill
git clone https://github.com/9railu/static-site-admin.git ~/.claude/skills/static-site-admin
```

Once installed, Claude will recognize requests like:
- *"add a local admin panel to this site"*
- *"I want to edit content from a browser UI"*
- *"set up a local admin server"*

…and copy + configure `template/admin.mjs` for your project.

## License

MIT

---

## 日本語 / Japanese

> 静的サイトにローカル管理UIを追加 — npm依存ゼロ、単一ファイル。

`template/admin.mjs` をプロジェクトにコピーして `node admin.mjs` を実行するだけで管理UIが立ち上がります。Vite / Astro / SvelteKit / Next.js static export など静的サイト全般に対応。

### 特徴

- **npm パッケージ不要** — Node.js 標準モジュールのみ
- **単一ファイル** — コピーして即起動
- **起動トークン認証** — 再起動するたびトークンが変わる
- **自動 HTTPS** — openssl があれば自己署名証明書を自動生成
- **LAN 共有** — 招待URL + ホスト承認フロー（6桁コード方式）
- **デプロイパイプライン** — `npm build → git add → commit → push` をSSEでリアルタイム進捗表示

### クイックスタート

```bash
# 1. テンプレートをコピー
cp template/admin.mjs your-project/scripts/admin.mjs

# 2. admin.mjs 上部の CONFIGURATION セクションを編集
#    （ポート番号、データファイルパス、git add 対象など）

# 3. 起動
node your-project/scripts/admin.mjs
```

コンソールに表示された URL をクリックしてログイン。Windows では自動でブラウザが開きます。

### カスタマイズ

`TODO` コメントの箇所を書き換えるだけでカスタマイズ完了：

- `CONFIGURATION` — ポート・パス設定
- `DATA HANDLERS` — 管理したいデータのスキーマと CRUD
- `DEPLOY PIPELINE` — `git add` 対象ファイルの調整
- `ADMIN UI` — HTML/CSS/JS の見た目
