# LAN Sharing

Give another device on the same network read/write access to the admin UI — without exposing the server token.

## How it works

```
Host machine                          LAN device (e.g. tablet, other PC)
     │                                          │
     │  1. Enable sharing in LAN tab            │
     │  → inviteCode generated (128-bit)        │
     │                                          │
     │  2. Share invite URL via QR/message ────▶│
     │                                          │  3. Opens /pair?invite=<code>
     │                                          │  4. Clicks "Request access"
     │                                          │  → 6-digit code displayed
     │                                          │
     │  5. See code in "Pending" section        │
     │  6. Click "Approve" ────────────────────▶│  7. Gets session cookie
     │                                          │  8. Redirected to admin UI
```

## Step by step

### Host side

1. Open the admin UI (`https://localhost:3099`)
2. Go to the **LAN Access** tab
3. Click the toggle to turn sharing **ON**
4. An invite URL appears for each LAN IP, e.g.:
   ```
   https://192.168.1.42:3099/pair?invite=abc123...
   ```
5. Copy the URL and send it to the other device (QR code, chat, etc.)
6. Wait for the device to appear in **Pending devices**
7. Verify the 6-digit code with the other user (in person or via call)
8. Click **Approve** — the device gains access

### LAN device side

1. Open the invite URL in a browser
2. You'll see a "Your connection is not private" warning — this is the self-signed certificate
   - Chrome: click **Advanced → Proceed to 192.168.x.x (unsafe)**
   - Safari: click **Show Details → visit this website**
3. Click **Request access**
4. A 6-digit code is displayed — share it with the host
5. Once the host approves, the page redirects to the admin UI automatically

## Revoking access

Access is session-based and stored only in memory. To revoke all LAN device access:

- **Restart the server** — all sessions (including host) are invalidated, a new token is generated
- **Turn sharing OFF** — generates a new invite code; existing sessions remain valid but no new devices can pair

To revoke a specific device, there is currently no per-session revoke. Restart the server.

## Security notes

- The invite URL is valid until sharing is turned OFF or the server restarts
- The 128-bit invite code makes it safe to share on a local network where others could see the server IP
- Session cookies are IP-bound: a device's cookie doesn't work from a different IP
- Pairing codes expire after 5 minutes
- The rate limiter allows 40 status polls per minute per IP (prevents enumeration)

## Troubleshooting

**"Sharing is disabled" page**  
The invite URL is valid but sharing was turned OFF on the host. Ask the host to re-enable sharing (a new invite URL will be generated).

**"Invalid invite URL" page**  
The server was restarted or sharing was toggled OFF and back ON (generating a new code). Ask the host for the new invite URL.

**Browser certificate warning won't go away**  
The self-signed cert may not include the LAN IP if the IP changed since the cert was generated. Delete `scripts/server.key` and `scripts/server.crt` and restart — a new cert covering current IPs will be generated.

**Code expires before host can approve**  
Codes expire after 5 minutes. The LAN device can click "Request again" to generate a new code. The `PAIR_TTL` constant can be increased in `admin.mjs` if needed.
