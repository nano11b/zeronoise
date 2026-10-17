# zeronoise game bridge kit

A small, dependency-free Node script that relays a game server to a zeronoise room, and (optionally) room chat back into the game. Works with FiveM, BeamMP, and anything that writes a log file or can make an HTTP request.

- `bridge.mjs`: the bridge (Node 18 or newer, no `npm install`)
- `config.example.json`: copy to `config.json` and edit
- Bot API reference: https://chat.nano11bravo.com/docs/bots

## 1. Make a bot and allow it

1. On zeronoise, open **Your profile → Chat bots** and create a bot. Copy the `bot_…` token (shown once).
2. Create your own room, then **More → Bots → Allow** your bot's name.
3. Get the room id from `GET /api/rooms` (for example `driftzone`).

## 2. Run it

```bash
cp config.example.json config.json      # set "room", remove sources you don't use
export ZN_BOT_TOKEN=bot_xxxxxxxx         # never put the token in config.json (the script refuses)
node bridge.mjs config.json --dry-run    # prints what it would post
node bridge.mjs config.json --once       # posts one "bridge self-test" line and exits
node bridge.mjs config.json              # run for real (use systemd, pm2, or txAdmin to keep it up)
```

`ZN_ROOM` and `ZN_BASE_URL` override the config file.

## 3. Sources (game → chat)

| type | what it does | settings |
| --- | --- | --- |
| `fivem-players` | polls FiveM's `players.json`, posts joins/leaves with the online count | `url`, `everyMs` (5000), `joinText`, `leaveText` (`{names}`, `{count}`) |
| `logtail` | follows a log file from its end and turns matching lines into chat | `file`, `preset: "beammp"` or `rules: [{ "match": "regex", "say": "text with $1" }]` |
| `webhook` | listens on `127.0.0.1:30121/say` for `POST {"text": "..."}` from a game resource | `host`, `port`; needs `BRIDGE_SECRET` in the environment, sent as header `x-bridge-secret` |

Lines are queued and sent about one every 1.5 s. Bursts within `mergeWithinMs` are merged into one line (500 characters max). On **429** the line is kept and retried (slow mode waits the stated seconds); on **403** the bot re-joins once and retries.

### FiveM (server-side Lua) → webhook

```lua
-- server.lua in any resource; set the same secret: set bridge_secret "..." in server.cfg and BRIDGE_SECRET for the bridge
local secret = GetConvar('bridge_secret', '')
local function zn(text)
  PerformHttpRequest('http://127.0.0.1:30121/say', function() end, 'POST', json.encode({ text = text }),
    { ['Content-Type'] = 'application/json', ['x-bridge-secret'] = secret })
end
AddEventHandler('myrace:finished', function(name, time) zn(('🏁 %s finished in %s'):format(name, time)) end)
```

### BeamMP

Point a `logtail` source at the BeamMP `Server.log` with `"preset": "beammp"` (joins, leaves, chat). Adjust the regexes with `rules` if your server version logs differently. A BeamMP Lua plugin can also call the webhook with `MP.` HTTP helpers if you prefer events over log lines.

## 4. Chat → game (optional)

Set `chatToGame.mode`:

- `stdout`: prints `[chat] name: text` (pipe it into your server console tool)
- `file`: appends lines to `chatToGame.file` for a resource/plugin to read
- `http`: POSTs `{author, text, line}` to `chatToGame.url` with header `x-bridge-secret`

The bridge reads with the documented cursor, starts at "now" (no history replay), and skips every line where `isBot` is true so it never echoes itself. Reads are every 2 s (the API allows 120 per minute per bot).

## Safety

- Keep the token in `ZN_BOT_TOKEN` (env var or a systemd `EnvironmentFile` readable only by the service user). Rotate it from **Chat bots** if it leaks.
- The webhook listens on `127.0.0.1` by default. Do not expose it publicly; it needs `BRIDGE_SECRET` either way.
- Bots can only join, post, send GIFs and read rooms they are allowed in. They cannot moderate.
