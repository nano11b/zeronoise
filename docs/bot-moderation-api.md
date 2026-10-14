# Moderator bot API

One chat bot can be the site moderator. Admins choose it in the mod panel (**Moderator bot**, or None) or with the CLI below. Every other bot can send messages, and can read rooms the creator has allowed it in. The check is on the server, on every request, so a change applies to live traffic without a restart.

The moderator bot can, in any room:

- kick a user (10-minute room ban)
- ban a user from a room (timed, or until lifted)
- site-ban a registered account (account, and IP and device when they are online)
- undo those (room unban and site unban)

It does not need to be in the room, and the room creator does not need to allow bots. It cannot kick or ban an admin, or itself. It cannot mute, delete messages, purge chat, or use any other moderation tool. Those routes return **403**.

Kicks and bans go through the same room-ban and site-ban records staff already use. Each moderator-bot action is written to the moderation log (bot name, target, room, reason, time). Admins and moderators see that log on `/admin` under **Action log**. It is kept for one year.

Meowington is created in the live database from the profile panel. This package does not create it. After a deploy, set it with the CLI (or the panel) against that database.

## Set the moderator bot

Panel: sign in as an admin, open `/admin`, and change **Moderator bot**. The dropdown lists existing bots, plus None.

CLI, as the service user, from the install directory (after `npm run build`):

```bash
node dist/server/set-moderator-bot.js Meowington
```

On the current host that is:

```bash
sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/dist/server/set-moderator-bot.js Meowington
```

Clear it with `--clear`. If the name is not in that database the script exits 1 and changes nothing. `DATA_DIR` defaults to `./data`.

## Authentication

Send the bot token (the `bot_…` secret shown once when the bot is created or rotated) on every call:

```
Authorization: Bearer bot_…
```

No session cookie and no `X-CSRF` header. These routes are meant to be called from your own program, including another origin.

`GET /api/bots/me` still works for any bot and returns `{ ok, id, name, owner }`. It does not show the token.

## Presence

While the moderator bot is calling the API, it is pinned at the top of every room's people list (name, avatar, and a "mod bot" badge). Any authenticated bot API call counts, including `GET /api/bots/moderation/messages`. The server remembers that last-seen time in memory for about 60 seconds. When the calls stop, the row disappears from every list. The next call puts it back. The change is pushed with the usual presence updates, so people already in a room see it without refreshing.

That row is not a person in the room. It is left out of "N online now" and the per-room people counts, it has no camera tile, and it cannot be kicked, banned, messaged, or called. A regular bot never appears this way. Changing or clearing the moderator bot in the panel removes the previous row immediately.

## Receiving chat

Bots do not open a Socket.IO session. Poll HTTP. Only the moderator bot may call these. A normal bot gets **403**.

The feed includes every room the server currently has, including private calls and rooms that never allowed bots. The newest 100 messages per room are what the server keeps.

### List rooms and who is in them

`GET /api/bots/moderation/rooms`

```json
{
  "ok": true,
  "rooms": [
    {
      "id": "alice-place",
      "name": "Alice Place",
      "topic": "",
      "isPrivate": false,
      "users": [
        { "id": "socket-id", "nick": "Alice", "role": "user", "accountId": 4 }
      ]
    }
  ]
}
```

`users[].id` is the socket id to pass as `userId` when you kick or room-ban someone who is in the room. `accountId` is null for a guest.

### Read messages

`GET /api/bots/moderation/messages?since=1710000000000&limit=100`

`GET /api/bots/moderation/rooms/:roomId/messages?since=1710000000000&limit=100`

Omit `since` to get the newest messages (up to `limit`, default 100, max 200), oldest first in the array. Pass `since` as a timestamp in milliseconds to get messages with `ts >= since`, oldest first, up to `limit`. The same millisecond can hold more than one message, so keep the ids you have already handled.

```json
{
  "ok": true,
  "messages": [
    {
      "id": "…",
      "ts": 1710000000123,
      "roomId": "alice-place",
      "nick": "Alice",
      "role": "user",
      "text": "hello",
      "userId": 4,
      "fromId": "socket-id"
    }
  ]
}
```

`userId` is the account id, or null for a guest. `fromId` is the live socket id when that person is still in the room, otherwise null. `role` is the role stored on the message.

### curl

```bash
curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  "https://chat.nano11bravo.com/api/bots/moderation/rooms"

curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  "https://chat.nano11bravo.com/api/bots/moderation/messages?since=1710000000000"
```

### Node

```javascript
const base = 'https://chat.nano11bravo.com';
const headers = { authorization: `Bearer ${process.env.BOT_TOKEN}` };

const rooms = await fetch(`${base}/api/bots/moderation/rooms`, { headers }).then((r) => r.json());
let since = Date.now() - 30_000;
for (;;) {
  const page = await fetch(`${base}/api/bots/moderation/messages?since=${since}`, { headers }).then((r) => r.json());
  if (!page.ok) throw new Error(page.error || 'feed failed');
  for (const msg of page.messages) {
    // dedupe by msg.id if you already stored this ts
    console.log(msg.roomId, msg.nick, msg.text, msg.fromId);
    if (msg.ts > since) since = msg.ts;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
```

## Kick

`POST /api/bots/moderation/kick`

Same effect as a room owner or moderator kicking: a 10-minute room ban, the person is removed, and their client gets `room:kicked`.

```json
{ "roomId": "alice-place", "userId": "socket-id", "reason": "spam" }
```

`username` may be used instead of `userId` (the name they are using in the room). One of the two is required. `reason` is optional and is stored in the action log.

```bash
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"roomId":"alice-place","userId":"SOCKET","reason":"spam"}' \
  https://chat.nano11bravo.com/api/bots/moderation/kick
```

```javascript
await fetch(`${base}/api/bots/moderation/kick`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: 'alice-place', userId: 'SOCKET', reason: 'spam' }),
});
```

Success is `{ "ok": true }`.

## Ban from a room

`POST /api/bots/moderation/ban`

Same room-ban record as **Ban from room**. `minutes` is a positive number up to 525600 (one year). Omit it, or send `null` or `0`, to ban until someone lifts it. The person must be in the room.

```json
{ "roomId": "alice-place", "username": "Alice", "minutes": 60, "reason": "disrupting the room" }
```

```bash
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"roomId":"alice-place","username":"Alice","minutes":60,"reason":"disrupting the room"}' \
  https://chat.nano11bravo.com/api/bots/moderation/ban
```

```javascript
await fetch(`${base}/api/bots/moderation/ban`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: 'alice-place', username: 'Alice', minutes: 60, reason: 'disrupting the room' }),
});
```

## Site ban

`POST /api/bots/moderation/site-ban`

Same site-ban records as a moderator **Site ban**: the account, plus that person's current IP and device ids when they are online. Then live sockets that match are disconnected. `reason` is required. `minutes` works like the room ban, with a cap of 5256000. Omit `minutes` for a permanent ban. The account does not have to be in a room. Guests have no account, so a guest cannot be site-banned this way (kick or room-ban them instead).

```json
{ "username": "Alice", "minutes": null, "reason": "ban evasion" }
```

`userId` (a live socket id) may be sent instead of `username` when you only have the socket.

```bash
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"Alice","minutes":null,"reason":"ban evasion"}' \
  https://chat.nano11bravo.com/api/bots/moderation/site-ban
```

```javascript
await fetch(`${base}/api/bots/moderation/site-ban`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'Alice', minutes: null, reason: 'ban evasion' }),
});
```

## Unban

`POST /api/bots/moderation/unban`

Room unban deletes the active room bans for that username in that room (the inverse of kick and room ban), so they can join again.

```json
{ "scope": "room", "roomId": "alice-place", "username": "Alice", "reason": "appeal accepted" }
```

Site unban lifts active site bans for that account, including IP and device bans labeled with that username.

```json
{ "scope": "site", "username": "Alice" }
```

Or lift one ban id from the mod panel:

```json
{ "scope": "site", "banId": 12 }
```

```bash
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"scope":"room","roomId":"alice-place","username":"Alice"}' \
  https://chat.nano11bravo.com/api/bots/moderation/unban

curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"scope":"site","username":"Alice"}' \
  https://chat.nano11bravo.com/api/bots/moderation/unban
```

```javascript
await fetch(`${base}/api/bots/moderation/unban`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'site', username: 'Alice' }),
});
```

## What normal bots can still do

A bot that is not the moderator bot can:

- `POST /api/bots/rooms/:roomId/join`
- `POST /api/bots/rooms/:roomId/chat` with `{ "text": "hello" }`
- `POST /api/bots/rooms/:roomId/gif` with `{ "id": "…" }`
- `GET /api/bots/rooms/:roomId/messages` (see below)

The room creator must have allowed that bot. Private calls stay closed. Chat is limited to 5 messages per 5 seconds per bot, and 30 chat/gif posts per minute per IP.

### Read new messages

`GET /api/bots/rooms/:roomId/messages?after=<message id>&limit=<1-100>`

Authorization is the same bearer token. This is how a game server (for example BeamMP) polls a room such as drivingnation.

The bot must be on that room's allow list. Otherwise the response is **403** `This bot is not allowed in that room`. A private call is **403** `Bots cannot join a private call`. An unknown room is **404** `Room not found`.

Reading does not require `join`. The allow list is in the database, so a bot can keep reading after the site process restarts even though its in-memory membership is gone. Posting still requires `POST .../join`, and that join is not remembered across a restart.

Messages are ascending (oldest first) and strictly after the cursor. Each line is:

| Field | Meaning |
| --- | --- |
| `id` | Message id. Also a cursor. |
| `ts` | Unix milliseconds. |
| `author` | Display name stored on the line. |
| `username` | Account username, or `null` for a guest or a bot. |
| `isBot` | `true` when a bot posted the line. |
| `bot` | That bot's name, or `null` for a person. If the bot was deleted later, this falls back to the display name. |
| `text` | The stored text, after banned-word masking. Plain text, not HTML. |

Deleted and moderated lines are left out. A deleted id is still a valid cursor, so paging does not stall on it. Lines posted before this field existed have `isBot: false` and `bot: null`.

**Cursor**

- No `after` and no `limit`: `messages` is empty and `cursor` is the newest message id in the room (even if that row was deleted), or `null` when the room has no messages. A fresh client does not replay history.
- No `after`, with `limit`: the last N non-deleted messages, ascending. `cursor` is the last of those, or the newest id when none are visible.
- `after` set: up to `limit` messages after that id (default 50). `cursor` is the last returned id, or the same `after` value when the page is empty.
- `limit` must be an integer from 1 to 100. Anything else is **400** `Bad limit`.
- An `after` value that is not a message id in that room, or is longer than 80 characters, is **400** `Unknown cursor`.

Poll about every 1–2 seconds: call once without `after` to learn the cursor, then call with `after` set to the previous response's `cursor`. When the first cursor is `null`, keep calling without `after` until a cursor appears, then switch. The line that first sets that cursor is the high-water mark and is not returned.

```json
{
  "ok": true,
  "messages": [
    {
      "id": "8f0c2c2e-1b4a-4e0a-9c1d-6a7b8c9d0e1f",
      "ts": 1710000000000,
      "author": "Alice",
      "username": "Alice",
      "isBot": false,
      "bot": null,
      "text": "hello"
    }
  ],
  "cursor": "8f0c2c2e-1b4a-4e0a-9c1d-6a7b8c9d0e1f"
}
```

This route is limited to **120 reads per minute per bot** (`BOT_ROOM_READS_PER_MIN`, default 120). That is its own bucket, separate from moderator-bot reads (60 per minute). A poll every 1–2 seconds stays under it. Over the limit the body is **429** `Slow down`. Authenticated calls count, including 403. A missing or unknown token does not.

## Routes that are always forbidden for bots

Any bot, including the moderator bot, gets **403** with `Bots cannot mute, delete messages, or run that moderation action`:

- `POST /api/bots/moderation/mute`
- `POST /api/bots/moderation/delete`

There is no bot Socket.IO event for kick, ban, mute, or delete. The human events `room:kick`, `room:ban`, `mod:ban`, `mod:mute`, and `mod:delete` require a signed-in person.

## Errors

The body is `{ "ok": false, "error": "…" }`. Status codes:

| Status | When | `error` |
| --- | --- | --- |
| 401 | No `Authorization: Bearer` header | Missing bot token |
| 401 | Token does not match a bot | Unknown bot token |
| 400 | Kick, room ban, or room unban without a room | roomId is required |
| 400 | No `userId` and no `username` | userId or username is required |
| 400 | Site ban without a reason | A reason is required |
| 400 | `minutes` is not a positive number within the cap | Bad duration |
| 400 | Unban `scope` is missing or not `room` or `site` | scope must be room or site |
| 400 | Site unban without a username or ban id | username is required |
| 400 | `since` or `limit` is not a valid number | Bad since / Bad limit |
| 400 | Room-read `limit` is not an integer from 1 to 100 | Bad limit |
| 400 | Room-read `after` is not a message id in that room | Unknown cursor |
| 403 | Token is not the current moderator bot | Only the moderator bot can do that |
| 403 | Mute, delete, or any other bot moderation tool | Bots cannot mute, delete messages, or run that moderation action |
| 403 | Target is an admin (including accounts in `ADMIN_USERNAMES`) | You cannot do that to an admin |
| 403 | Target is this bot (its `bot:<id>` id or its name) | You cannot do that to yourself |
| 404 | Unknown room | Room not found |
| 404 | Kick or room ban, and that person is not in the room | User not in room |
| 404 | Site ban or site unban, unknown username | No such user |
| 404 | Nothing active to lift | No active ban / No active room ban |
| 429 | Too many bad tokens from one IP (30 per minute) | Too many attempts. Try again later. |
| 429 | Moderation writes: 30 per minute per bot and per IP | Slow down |
| 429 | Moderator room and message reads: 60 per minute per bot | Slow down |
| 429 | Room chat reads (`GET /api/bots/rooms/:roomId/messages`): 120 per minute per bot | Slow down |

A normal bot receives **403** on kick, room ban, site ban, unban, mute, delete, and the moderator read routes, and nothing is changed. `GET /api/bots/rooms/:roomId/messages` is allowed for any bot the room creator has allowed.

## Action log

Successful kick, room ban, site ban, room unban, and site unban each insert a moderation-log row:

| Column | Value |
| --- | --- |
| actor | the bot's name |
| target | the person's name |
| room | the room id, or empty for a site unban |
| details | the reason (and duration, for bans) |
| time | unix milliseconds |

Designating the bot (panel or CLI) is also logged, with action `moderator-bot`.
