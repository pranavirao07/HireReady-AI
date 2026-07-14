# HireReady AI — Backend

A minimal, **zero-dependency** backend for HireReady AI. Real accounts, real password
hashing, real persistence — no `npm install` required.

## Why zero dependencies

This uses only Node's built-in modules: `node:http` for the server, `node:sqlite` for
a real database, and `node:crypto` for password hashing and session tokens. That means:

- No `npm install` step, no waiting, nothing that can fail to install
- No native binaries to compile (a common pain point with SQLite libraries)
- Works the moment you have Node.js installed

## Requirements

**Node.js 22.5 or newer** (for the built-in `node:sqlite` module). Check with:

```bash
node --version
```

If you're on an older Node version, the server automatically falls back to a simple
JSON-file database (`data.json`) instead — everything still works, just without a real
SQL database underneath. You'll see which mode is active in the startup log.

## Running it

```bash
cd backend
node server.js
```

You should see:

```
HireReady AI backend running at http://localhost:3001
Storage: SQLite (.../hireready.db)
```

That's it — no build step, no install step.

## Connecting the frontend

The main site (`hireready-ai.html`) is already wired to call this backend automatically
at `http://localhost:3001`. Just:

1. Start this backend (`node server.js`)
2. Open `hireready-ai.html` in your browser
3. Sign up / log in — accounts and scores now persist for real, across refreshes and
   browser restarts

**If the backend isn't running**, the site still works — it automatically falls back to
the original in-memory-only mode (accounts just won't survive a refresh). You don't need
to change anything either way; the frontend detects whether the backend is reachable.

## API reference

| Method | Path | Auth required | Body | Description |
|---|---|---|---|---|
| POST | `/api/signup` | No | `{ name, email, password }` | Create an account |
| POST | `/api/login` | No | `{ email, password }` | Log in |
| POST | `/api/logout` | Yes | — | Invalidate the current session |
| GET | `/api/me` | Yes | — | Get the current logged-in user |
| POST | `/api/scores` | Yes | `{ category, score }` | Save a practice score |
| GET | `/api/scores` | Yes | — | Get all of your saved scores |
| GET | `/api/dashboard` | Yes | — | Computed readiness score, streak, XP, level |
| GET | `/api/health` | No | — | Check the server is up + which storage mode is active |

Authenticated requests need an `Authorization: Bearer <token>` header, using the token
returned from signup/login.

## Data storage

- **SQLite mode**: a single file, `hireready.db`, created automatically in this folder.
  Delete it to reset all data.
- **JSON fallback mode**: a single file, `data.json`, same idea.

Passwords are never stored in plain text — they're hashed with `scrypt` and a random
per-user salt.

## Known limitations (being upfront about this)

- **CORS is wide open** (`Access-Control-Allow-Origin: *`) so the frontend can call it
  from a `file://` page. Fine for local/personal use; you'd want to restrict this to a
  specific origin before deploying anywhere public.
- **No rate limiting** on login/signup — fine for a portfolio project, not production-grade.
- **Sessions never expire** — there's no token expiry/cleanup logic. Simple on purpose;
  add it if you take this further.
- This is intentionally minimal — a real production app would add things like email
  verification, password reset, refresh tokens, and input validation beyond the basics
  already here.

## Deploying it somewhere real

Since this has zero dependencies, deploying it is just "get Node 22.5+ running somewhere
and run `node server.js`" — works on Render, Railway, a VPS, etc. If you deploy it
somewhere other than `localhost:3001`, update the `API_BASE` constant near the top of
the `<script>` section in `hireready-ai.html` to point at your deployed URL.
