# Security Design

`static-local-admin` is designed as a **localhost-only** admin tool that never faces the internet. This document explains each security layer and the reasoning behind it.

## Threat model

| Attacker | Goal | Mitigated by |
|----------|------|--------------|
| Internet scanner | Find the admin UI | Private IP restriction (socket-level) |
| Someone on same LAN | Access admin UI without permission | Invite URL + host approval pairing |
| Attacker who got the invite URL | Gain access without host approval | 6-digit code must be approved by host |
| Malicious website visited by admin | CSRF attack | SameSite=Strict + Sec-Fetch-Site + Origin check |
| Attacker who intercepted traffic on LAN | Read/modify data | Auto HTTPS (self-signed cert with LAN IPs in SAN) |
| Admin who lost a browser session | Revoke all access | Restart the server — token changes, all sessions invalidated |

## Layer 1: Private IP restriction

All requests are rejected unless they come from a private IP address range:

```js
function isPrivateIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' ||
    /^192\.168\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
if (!isPrivateIp(peerIp)) return sendError(res, 403, 'Forbidden');
```

**Why `req.socket.remoteAddress` and not `req.headers['host']`?**  
The `Host` header is set by the client and can be spoofed by an attacker. The socket's remote address is set by the OS TCP stack and reflects the actual connecting IP — it cannot be faked.

**Why include `'localhost'` as a string?**  
The `Origin` header from a browser making requests to `http://localhost:3099` has hostname `'localhost'` (a string), not `'127.0.0.1'`. Both must be allowed or CSRF checks will reject all localhost POST requests.

## Layer 2: Launch-token authentication

On startup, a random 192-bit token is generated:

```js
const TOKEN = crypto.randomBytes(24).toString('base64url');
```

The admin URL printed to the console is:
```
https://localhost:3099/login?token=<TOKEN>
```

Visiting this URL sets an `HttpOnly; SameSite=Strict` cookie. After that, the token in the URL is no longer needed — the cookie authenticates future requests.

**Key properties:**
- Token changes every time the server restarts — a leaked URL expires immediately on restart
- Cookie is `HttpOnly` — JavaScript cannot read it (prevents XSS-based token theft)
- Cookie is `SameSite=Strict` — not sent with cross-site requests
- Cookie is `Secure` when HTTPS is active

## Layer 3: CSRF protection (defense-in-depth)

Even though `SameSite=Strict` already blocks cross-site cookie delivery, a second layer checks request headers:

```js
if (['POST', 'DELETE', 'PATCH'].includes(method)) {
  const sf = req.headers['sec-fetch-site'];
  if (sf && sf !== 'same-origin' && sf !== 'none') return sendError(res, 403, 'Forbidden');
  const origin = req.headers['origin'];
  if (origin && !isAllowedOrigin(origin)) return sendError(res, 403, 'Forbidden');
}
```

- `Sec-Fetch-Site` is a browser-set header that cannot be faked by JavaScript — it is only sent by browsers and always reflects the true request origin
- `Origin` is checked against the private IP whitelist as a fallback

## Layer 4: Auto HTTPS

If `openssl` is found on startup, a self-signed certificate is generated that covers:
- `DNS:localhost`
- `IP:127.0.0.1`
- All current LAN IPs (`IP:192.168.x.x` etc.)

This means the same certificate works for both localhost and LAN access. The cert is generated once and reused on subsequent startups.

If `openssl` is not found, the server falls back to HTTP with a warning.

**Browser warning:** Self-signed certificates trigger a "Your connection is not private" browser warning. Click "Advanced → Proceed" to continue. This is expected and is not a security problem for a local-only tool.

**Add to `.gitignore`:**
```
scripts/server.key
scripts/server.crt
```

## Layer 5: LAN device pairing

LAN devices are not trusted by default. They must go through an explicit approval flow:

1. Host enables sharing → a 128-bit invite code (`inviteCode`) is generated
2. Invite URL contains the code: `/pair?invite=<128bit>`
3. LAN device opens the invite URL → verified against `inviteCode`
4. Device clicks "Request access" → server generates a 6-digit code and associates it with the device's IP
5. Host sees the code in the admin UI and clicks "Approve"
6. A session token is issued, bound to the device's IP
7. When the device polls `/api/pair/status`, it only receives the token if the IP matches

**Why invite URL (128-bit random)?**  
On a shared Wi-Fi (café, hotel), anyone on the network can see LAN broadcast traffic and discover the server's IP. Without the invite code, they could open the pairing page. The 128-bit invite code is effectively unguessable (2^128 possibilities), so only people the host explicitly shares the URL with can even reach the pairing flow.

**Why 6-digit approval code?**  
The host and the LAN device user are typically in the same physical space (or on a video call). The 6-digit code displayed on the device lets the host visually verify "yes, this is my device" before approving. It prevents an attacker who somehow got the invite URL from silently gaining access.

**Polling rate limit:**
```js
if (entry.count >= 40) return false;  // 40 polls/minute per IP
```

## Layer 6: Body size limit

```js
const MAX_BODY = 50 * 1024 * 1024; // 50MB
if (total > MAX_BODY) { req.destroy(); return reject(new Error('body too large')); }
```

`req.destroy()` tears down the TCP connection immediately — it does not send a response, preventing the server from being used as a memory exhaustion vector.

## Layer 7: Path traversal protection

```js
function serveFileSafe(baseDir, rawSegment, res) {
  if (rawSegment.includes('..') || rawSegment.includes('\\')) return sendError(res, 403, 'Forbidden');
  const decoded = decodeURIComponent(rawSegment);
  const resolved = path.resolve(baseDir, decoded);
  const base = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : baseDir;
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return sendError(res, 403, 'Forbidden');
  // serve file...
}
```

- Raw `..` and `\\` are rejected before URL decoding (catches encoded traversal like `%2e%2e`)
- After decoding, the resolved path is verified to be inside the base directory using `path.resolve` + prefix check
- `fs.realpathSync` resolves symlinks in the base directory to prevent symlink-based escapes

## XSS note

The admin HTML uses `innerHTML` extensively for performance, but all user-supplied strings pass through an `esc()` function that escapes `&`, `<`, `>`, `"`, and `'`. External sanitizer libraries like DOMPurify are intentionally not used to keep the zero-dependency guarantee.
