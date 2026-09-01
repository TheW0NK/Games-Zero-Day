# Zero Day — hosted build

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
  can add, modify, deactivate, remove, mute, or set the currency balance of
  other accounts from Settings > Users (or `setbalance <user> <amount>` in
  the Terminal) — handy for correcting an exploited bug or just moderating.
  Superusers also get an **Admin Panel** app (hidden from everyone else's
  Start Menu) with the same account-management tools plus at-a-glance
  stats — total accounts, total currency in circulation, and superuser
  count — and a one-click **Clear Malware** action per user for wiping out
  someone's infections without touching anything else on their account.
  Passwords are never stored or logged in plain text: each one is hashed
  with `scrypt` and a random per-account salt (`hashPassword`/
  `passwordMatches` in `server.js`), compared with a timing-safe check, and
  the hash is never included in any API response. That's intentionally a
  one-way hash rather than reversible encryption — nothing in the app, not
  even a superuser, can ever recover a user's actual password from it.
- **Files app / Terminal** read and write actual files under
  `./userfiles/<username>/` on this machine. Each account has its own home;
  delete something in Files, it's gone from disk. Create a file in Terminal,
  it shows up in Files. Restart the server, it's still there. Every account
  — new signups, superuser-created accounts, and any existing account
  back-filled at boot — gets the same starter tree (`defaultTree()` in
  `server.js`: a readme, a todo list, empty starter folders) plus three real
  demo tracks copied into `Music/` from `./assets/demo-music/` by
  `seedDemoMusic()`; it only ever adds a missing or zero-byte file, so it
  never overwrites something you've uploaded or re-adds one you deleted on
  purpose.
- **System Wipe** is self-service and localized: any signed-in user can
  confirm their own password from Settings to erase only their own
  `./userfiles/<username>/` home, clear every one of their own malware
  infections, and regenerate the starter tree — it never touches other
  accounts. Both the frontend confirmation flow and `POST
  /api/system/reset` scope entirely to the calling session's own user.
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
- **Writer**, **Sheets**, and the VS Code-inspired **Zero Day IDE** provide
  basic document, spreadsheet, and HTML app authoring workflows.
- **Music Player** plays only the real `.mp3` files in each user's `Music`
  folder — add songs there from the Files app, the player's own upload
  button, or the Terminal, and they show up in the playlist.
- **Sign Up / Sign In** — after boot, a non-`HttpOnly` `aegis_known_device`
  cookie (set on any successful login or signup) decides which screen shows:
  no cookie routes to Sign Up, an existing one routes to Sign In. Logging out
  doesn't clear it, so a returning device keeps landing on Sign In. (The
  cookie name and other internal KV-key prefixes were kept as-is during the
  Zero Day rebrand — no player-visible benefit to renaming them, and it
  would've added migration risk for existing sessions/data.) The first
  account signed in on any desktop gets a one-time **Tutorial** window
  covering the desktop, money, hacking, defense, and chat basics — it won't
  auto-show again after that, but it's always reachable from the Start
  Menu. Superusers get an extra section in it introducing the Admin Panel.
- **Currency & Bank** — every account starts with $2,500, stored on the user
  record in `./data/users.json`. The **Bank** app (balance, transfers,
  transaction history, ransom payoff) is the GUI half; `wallet`,
  `transfer <user> <amount>`, and `payransom` are the Terminal half.
  Transactions log to `./data/bank.json`.
- **Hacking** is entirely Terminal-driven and primarily skill-based, not
  pay-to-win: `scan <user>` recons a target's open ports for free; `secure
  <port> <ratelimiter|sentinel|decoy>` ($150) lets a player install their own
  defense module on one of their own open ports; `deepscan <user>` ($75)
  reveals which module (if any) guards each of a target's ports. Attacking
  means picking a port and an approach — `exploit <user> <port>
  <bruteforce|stealth|injection>` ($20/attempt) — and the three approaches
  and three modules form a closed counter triangle (bruteforce beats decoy
  but loses to ratelimiter; stealth beats ratelimiter but loses to sentinel;
  injection beats sentinel but loses to decoy). Picking the right counter
  (or paying for a `deepscan`) doesn't win the breach outright, though —
  `exploit` starts a Mastermind-style code-breaking puzzle (`guess n n n n`,
  four digits 1-6, exact/partial feedback) instead of an instant dice roll.
  The matchup and firewall differential still matter, but now they set the
  puzzle's difficulty (3 guesses on a bad matchup, up to 8 on a great one)
  rather than being the whole outcome — cracking it is real, repeatable
  skill. A persistent backdoor infection skips the puzzle entirely (instant
  breach); everything else clamps between the 3-8 guess range, so no
  purchase ever makes a breach automatic or impossible. A successful breach
  opens a 2-minute window to `steal` money or `deploy <malware>` — see
  `malware` for the full catalog of viruses, trojans, worms, ransomware,
  spyware, rootkits, adware, and a botnet client, each with a real
  mechanical effect (balance drain, a persistent backdoor, an
  account-locking ransom, log-hiding, remote monitoring, firewall
  weakening, or jamming the target's ability to counter). `avscan` tries to
  clean your own infections; `secstatus` shows your own security profile,
  installed modules, and intrusion log. Every account's security profile
  lives alongside its user record.
  Payouts are gated by a **security percentage** (`securityPercent` in
  `server.js`) — the equally-weighted average of firewall level, antivirus
  level, and the fraction of your own ports carrying an installed module,
  0-100. `steal` and drain-type malware scale their payout by this
  percentage, and ransomware-type malware refuses to deploy at all against
  a target sitting at exactly 0% — there's no money in farming an account
  that hasn't invested anything, which is the intended incentive to leave
  brand-new players alone and go after well-defended (presumably richer)
  targets instead. It's shown in `scan`, `deepscan`, `secstatus`, and the
  Firewall app.
  A breach isn't purely one-sided, either: the moment a puzzle is cracked
  (or a backdoor lets someone straight in), the target gets pushed a
  real-time alert over Server-Sent Events (`GET /api/events`) — no polling
  delay — with a 45-second window to `counter`. Countering is a chance
  check (antivirus vs. the attacker's firewall) that, on success, expels
  them before they can act; Silencer-type malware installed on you blocks
  countering until you clean it off with `avscan`. A cloak-type infection
  (Nullroot/Hollowman) suppresses this alert entirely for that attacker —
  full stealth, not just a hidden log entry. `leaderboard` (or `top`) shows
  the ten richest active accounts.
  A serious infection has one more consequence: any **tier 2** malware
  sitting on your account visibly glitches Recovery Mode once you're in it,
  and any **tier 3** malware gives Recovery Mode a real (~45%) chance of
  failing to boot into at all on a given attempt, kicking you back out with
  an error toast — thematically, the moment you most need Recovery Mode
  (to clean up an infection) is the moment it's hardest to reach. Running
  `avscan` (or having a superuser clear your malware from the Admin Panel)
  immediately restores normal, reliable access.
  The **Firewall** and **Antivirus** App Store
  apps are GUI front-ends for the same `/api/hack/*` endpoints (level
  upgrades, per-port modules, scanning) if you'd rather not use the
  Terminal for defense — attacking another player stays Terminal-only.
- **Chat** now has three tabs in one window: **Direct** (1:1, unchanged),
  **Public** (one shared room every active account can read and post to,
  stored in `./data/public-chat.json`), and **Groups** (member-scoped rooms
  a player creates and invites people into, stored in `./data/groups.json` +
  `./data/group-messages.json`; the creator is the owner and can add/remove
  members or delete the group, anyone can leave). A Block button on a DM
  contact stops messages in both directions until unblocked
  (`/api/social/block`); blocked usernames live on the user record. Every
  message on every surface passes through a shared, whole-word slur filter
  before it's stored — see `containsBannedContent` in `server.js` to extend
  the pattern list. Superusers can delete any message (regular users can
  delete their own) and mute an account from Settings > Users, which blocks
  that account from posting anywhere until unmuted.
- **Boot** runs the textual POST first (normal firmware-chatter speed),
  then a 3-5s "Prismonian Games Presents" splash, then a 5-7s loading bar
  before landing on Sign Up/Sign In. Pressing any key 5 times during the
  loading bar skips straight to the auth screen. Firmware/BIOS setup has
  been removed entirely; **Startup Settings** (non-destructive diagnostics
  and boot-log viewing) is reachable only from inside Recovery Mode now,
  not from a boot-time keypress.
- **Snake** and **2048** both track a persisted personal best score and pay
  out a small currency bonus on game over (capped, on a few-minutes
  cooldown so it's not farmable) — Snake also has pause (P/Escape), and
  2048 has a single-level undo.
- `userfiles/` and `data/` are gitignored on purpose, so a fresh clone/rebuild
  always starts from the clean default tree rather than committing your demo
  files to source control.
