# static-site-admin-skill

A Claude Code skill that adds a secure local admin UI to any static site.

## Install

```bash
git clone https://github.com/9railu/static-site-admin-skill.git ~/.claude/skills/static-site-admin-skill
```

## What it does

When you ask Claude to add a local admin panel to a project, this skill:

1. Copies `template/admin.mjs` into your project (`scripts/admin.mjs`)
2. Configures the `PORT`, `DATA_FILE`, and `GIT_ADD_PATHS` constants for your project
3. Implements `handleGetData` / `handlePostData` / `handleDeleteItem` for your schema
4. Adds `server.key` and `server.crt` to `.gitignore`

Then run:

```bash
node scripts/admin.mjs
```

## Trigger phrases

- "add an admin panel"
- "manage content locally"
- "edit JSON from a browser UI"
- "upload images and auto-deploy"
- "access from iPad on the same Wi-Fi"
- "admin UI without adding npm packages"

## Security (built-in, no config needed)

| Feature | How |
|---------|-----|
| Blocks internet traffic | Private IP check on `req.socket.remoteAddress` |
| Auth | Random launch-token per startup as `HttpOnly` cookie |
| HTTPS | Auto self-signed cert via openssl |
| CSRF | `SameSite=Strict` + `Sec-Fetch-Site` + `Origin` check |
| LAN sharing | Invite URL + host-approval 6-digit pairing code |
| Path traversal | `path.resolve` + prefix check on every file |

## Examples

| Example | Path | Schema |
|---------|------|--------|
| Blog posts | `examples/blog-posts/admin.mjs` | title / content / date / published |
| Photo gallery | `examples/photo-gallery/admin.mjs` | WebP conversion + VRChat XMP |

## Docs

- [`docs/customization.md`](docs/customization.md) — data handlers, upload handling, deploy pipeline
- [`docs/security.md`](docs/security.md) — full security design
- [`docs/lan-sharing.md`](docs/lan-sharing.md) — LAN pairing guide
