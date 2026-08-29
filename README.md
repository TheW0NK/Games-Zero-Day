# Aegis OS — hosted build

The same OS demo, now running with a real backend instead of browser-storage
workarounds.

## Run it in a Codespace

1. Push this folder to a GitHub repo (or open it directly if it's already one).
2. Open it in a Codespace. The devcontainer runs `npm install` for you and
   starts the server automatically; Codespaces will forward port 3000 and
   offer to open it in your browser.
3. If it doesn't start on its own: `npm start`, then open the forwarded port.

## Run it anywhere else

```
npm install
npm start
```

Then open http://localhost:3000

## What's actually real now (vs. the browser-only version)

- **User accounts** are stored under `./data/users.json`. There's no seeded
  default account — the boot screen is a self-service Sign Up / Sign In pair,
  and the very first account ever created becomes the superuser. Superusers
  can add, modify, deactivate, or remove other accounts from Settings > Users.
- **Files app / Terminal** read and write actual files under
  `./userfiles/<username>/` on this machine. Each account has its own home;
  delete something in Files, it's gone from disk. Create a file in Terminal,
  it shows up in Files. Restart the server, it's still there.
- **System Wipe** requires a superuser credential set, then resets every
  `./userfiles/<username>/` home and regenerates the starter tree. User
  accounts are retained so an administrator can sign back in.
- **Browser app**'s "Full Page" mode routes through `/proxy`, a plain Express
  route on this same server — it fetches the target page itself, strips the
  headers that block iframe embedding, and serves the result back
  same-origin. No third-party service, no shared rate limit.
- Settings and terminal history are stored as small JSON files under
  `./data/kv/`.

## What's still limited, on purpose

- `/proxy` is a straightforward implementation — fetch, strip headers, inject
  a `<base>` tag so relative-path assets resolve correctly. It's not a
  hardened production proxy. Sites with frame-busting JavaScript, or APIs
  that reject cross-origin requests, can still misbehave.
- Authentication uses server-side sessions and protects the filesystem, KV,
  and proxy APIs. For production deployment, put the app behind HTTPS and a
  persistent session store rather than the in-memory session map.
- **System Monitor** shows live server uptime, memory, processor count,
  sessions, host details, and a bounded superuser activity log.
- **App Store** installation state is persisted per user; optional apps are
  removed from the Start menu when uninstalled.
- **Desktop icons** can be added from the desktop context menu, moved by
  dragging, removed, and restored per user.
- **Uploads** accept arbitrary file types except ZIP files and save binary
  data in the current user directory.
- **Writer**, **Sheets**, and the VS Code-inspired **Aegis IDE** provide basic
  document, spreadsheet, and HTML app authoring workflows.
- **Music Player** plays only the real `.mp3` files in each user's `Music`
  folder — add songs there from the Files app, the player's own upload
  button, or the Terminal, and they show up in the playlist.
- **Sign Up / Sign In** — after boot, a non-`HttpOnly` `aegis_known_device`
  cookie (set on any successful login or signup) decides which screen shows:
  no cookie routes to Sign Up, an existing one routes to Sign In. Logging out
  doesn't clear it, so a returning device keeps landing on Sign In.
- **Currency & Bank** — every account starts with $2,500, stored on the user
  record in `./data/users.json`. The **Bank** app (balance, transfers,
  transaction history, ransom payoff) is the GUI half; `wallet`,
  `transfer <user> <amount>`, and `payransom` are the Terminal half.
  Transactions log to `./data/bank.json`.
- **Hacking** is entirely Terminal-driven: `scan <user>` recons a target's
  firewall/antivirus level and open ports, `exploit <user>` attempts a breach
  (odds driven by both players' firewall levels), and a successful breach
  opens a 2-minute window to `steal` money or `deploy <malware>` — see
  `malware` for the full catalog of viruses, trojans, worms, ransomware,
  spyware, rootkits, adware, and botnet clients, each with a real mechanical
  effect (balance drain, a persistent backdoor, an account-locking ransom,
  log-hiding, remote monitoring, or firewall weakening). `avscan` tries to
  clean your own infections; `firewall upgrade` / `antivirus upgrade` spend
  balance to raise your defenses; `secstatus` shows your own security
  profile and intrusion log. Every account's security profile lives
  alongside its user record.
- **BIOS setup** is available only by pressing a key during the textual POST
  screen. Recovery also includes non-destructive diagnostics and boot-log
  viewing.
- `userfiles/` and `data/` are gitignored on purpose, so a fresh clone/rebuild
  always starts from the clean default tree rather than committing your demo
  files to source control.
