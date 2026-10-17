# Load test (batch H7)

`npm run build && node scripts/load-test.mjs --clients 200 --out report.json`

It starts a local server with a fresh data dir and `SQL_PROFILE` on. It registers 200 accounts (each with its own client IP), connects 200 sockets plus an admin, and makes 10 rooms (20 people each). It seeds 30,000 messages, has every client send 5 lines, and calls the admin, search and analytics endpoints while the load is running. Then 50 clients reconnect at once. It prints p50/p95/max per operation and the SQL statements that took the most total time. `SQL_PROFILE=<file>` works on any server: totals per statement are written on exit or SIGUSR2.

## Findings and fixes

1. **Message search blocked the server for up to 3.4 s.** SQLite walked every message in the room and ran the FTS match once per row. A query with no hits ("coffee game") was the worst case. Every request queued behind it, which is why `/api/me`, `/api/status` and the admin pages all showed the same 3.4 s. Fix: `CROSS JOIN` makes the FTS index drive the query. The worst case went from 3471 ms to 0.4 ms.
2. **Room join built history one line at a time.** For each of the 100 lines it looked up the user, link preview, poll and announcement separately: about 15,000 small queries for 200 joins. Fix: one batched query per kind for each history page.
3. **Join payload.** Empty defaults (`reactions: []`, `mentions: []`, `chatColor: null`, `hasAvatar: false`, `fromId: ''`) are dropped from history lines; the client already treats a missing field as empty. Result: 26 KB → 17 KB per join.
4. **Admin action log** is now paged: 100 per page with a "Load older" button, keyed on the row id. Before, it sent 200 rows on every refresh.
5. **Indexes:** `mutes(expires_at)`, which is checked on every chat line, and `room_visitors(day)`, used for site stats.

## Before / after (same machine, same script)

| operation | before p50 / p95 / max (ms) | after p50 / p95 / max (ms) |
|---|---|---|
| http register | 1363.2 / 1829.8 / 3669.2 | 1465 / 1823.1 / 3721.9 |
| socket connect+login | 24.1 / 97.6 / 194 | 25.1 / 84.9 / 133.7 |
| room:join | 43.3 / 46.9 / 48.1 | 31.4 / 40.3 / 43.7 |
| chat fan-out (send→receive) | 1.1 / 5.5 / 15.1 | 1.2 / 5.3 / 15.2 |
| chat:send ack | 3.5 / 7.5 / 18.9 | 3.9 / 7.7 / 18.8 |
| stats:analytics | 1.8 / 1.9 / 1.9 | 1.7 / 2 / 2 |
| rooms:list | 1.7 / 2.1 / 2.1 | 1.6 / 2.2 / 2.2 |
| chat:search | 364 / 3400.2 / 3400.2 | 4.3 / 12.4 / 12.4 |
| GET /api/me | 366.2 / 3402.2 / 3402.2 | 6.3 / 15.3 / 15.3 |
| GET /api/status | 366.1 / 3402.2 / 3402.2 | 6.2 / 15 / 15 |
| GET /api/admin/users?q=load | 367.1 / 3403.5 / 3403.5 | 7.5 / 18.3 / 18.3 |
| GET /api/admin/log | 367.7 / 3404.3 / 3404.3 | 7.9 / 19.7 / 19.7 |
| GET /api/admin/stats | 369.3 / 3405.7 / 3405.7 | 8.8 / 21.4 / 21.4 |
| GET /api/admin/reports | 369.4 / 3405.9 / 3405.9 | 9.3 / 22 / 22 |
| GET /api/me/rooms/analytics | 370.2 / 3406.6 / 3406.6 | 9.9 / 22.9 / 22.9 |
| rejoin after reconnect | 52.9 / 97.4 / 148.5 | 19.7 / 48.2 / 51.9 |

| payload | before p50 / max (KB) | after p50 / max (KB) |
|---|---|---|
| room:join payload KB | 26.1 / 31.6 | 16.9 / 22.4 |
| rooms:list KB | 2.5 / 2.5 | 2.5 / 2.5 |
| admin users KB | 13.2 / 13.2 | 13.2 / 13.2 |
| admin log KB | 25.4 / 25.4 | 12.9 / 12.9 |


Registration is slow on purpose (password hashing); its numbers are only there for reference.
