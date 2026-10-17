import path from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { DATA_DIR } from './env';

export const DB_PATH = path.join(DATA_DIR, 'camchat.db');
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

/**
 * Append-only list of migrations. Never edit a shipped entry; add a new one. PRAGMA user_version tracks progress.
 * Each label is the user_version the entry leads to (entry index + 1). Labels 30-35 were renumbered in
 * the comments only (they used to read 33-37 with 30 unlabeled); the SQL and order are unchanged.
 */
const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','moderator','user')),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    last_ip TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,               -- HMAC of the cookie token (token itself is never stored)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL DEFAULT '',
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    owner_nick TEXT,
    permanent INTEGER NOT NULL DEFAULT 0,   -- built-in (seeded) room
    persistent INTEGER NOT NULL DEFAULT 1,  -- survives restarts; 0 = guest room, removed when empty
    created_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    nick TEXT NOT NULL,
    role TEXT,
    text TEXT NOT NULL,
    ip TEXT,
    device_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX messages_room_ts ON messages(room_id, ts);
  CREATE TABLE bans (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('account','ip','device')),
    value TEXT NOT NULL,
    label TEXT,                         -- e.g. nickname at the time of the ban
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,                 -- NULL = permanent
    lifted_at INTEGER,
    lifted_by TEXT
  );
  CREATE INDEX bans_lookup ON bans(kind, value);
  CREATE TABLE room_bans (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_key TEXT, ip TEXT, device_id TEXT, nick TEXT,
    reason TEXT, created_by TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX room_bans_room ON room_bans(room_id);
  CREATE TABLE mutes (
    id INTEGER PRIMARY KEY,
    user_key TEXT, ip TEXT, device_id TEXT, nick TEXT,
    created_by TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    reporter_user_id INTEGER, reporter_nick TEXT NOT NULL, reporter_ip TEXT,
    target_user_id INTEGER, target_nick TEXT, target_ip TEXT, target_device TEXT,
    room_id TEXT, message_id TEXT, message_text TEXT,
    reason TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '[]',
    handled_by TEXT, handled_at INTEGER, note TEXT
  );
  CREATE INDEX reports_status ON reports(status, created_at);
  CREATE TABLE mod_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    room_id TEXT,
    details TEXT
  );
  CREATE INDEX mod_log_ts ON mod_log(ts);
  `,
  // 2: friends, password resets, room moderation settings, private call rooms
  `
  CREATE TABLE friendships (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, peer_id),
    CHECK (user_id < peer_id)
  );
  CREATE INDEX friendships_user ON friendships(user_id, status);
  CREATE INDEX friendships_peer ON friendships(peer_id, status);
  CREATE TABLE password_resets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX password_resets_user ON password_resets(user_id);
  ALTER TABLE rooms ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN slow_mode_sec INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
  `,
  // 3: Discord OAuth (snowflake id, parallel to google_sub).
  // SQLite cannot ADD COLUMN ... UNIQUE; use a unique index instead.
  `
  ALTER TABLE users ADD COLUMN discord_id TEXT;
  CREATE UNIQUE INDEX users_discord_id ON users(discord_id) WHERE discord_id IS NOT NULL;
  `,
  // 4: chat nick color + avatar flag (files live in DATA_DIR/avatars/{id}.webp)
  `
  ALTER TABLE users ADD COLUMN chat_color TEXT;
  ALTER TABLE users ADD COLUMN has_avatar INTEGER NOT NULL DEFAULT 0;
  `,
  // 5: per-message emoji reactions
  `
  CREATE TABLE message_reactions (
    message_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_key, emoji)
  );
  CREATE INDEX message_reactions_msg ON message_reactions(message_id);
  `,
  // 6: optional room password (bcrypt hash; NULL = open)
  `
  ALTER TABLE rooms ADD COLUMN password_hash TEXT;
  `,
  // 7: threads, edits, pins
  `
  ALTER TABLE messages ADD COLUMN parent_id TEXT;
  ALTER TABLE messages ADD COLUMN edited_at INTEGER;
  CREATE INDEX messages_parent ON messages(parent_id);
  CREATE TABLE message_pins (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    pinned_at INTEGER NOT NULL
  );
  CREATE INDEX message_pins_room ON message_pins(room_id, pinned_at);
  `,
  // 8: preset chat name effect (none stored as NULL)
  `
  ALTER TABLE users ADD COLUMN chat_effect TEXT;
  `,
  // 9: one WHIP stream key per room. Plaintext is never stored.
  `
  CREATE TABLE stream_keys (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'OBS',
    created_at INTEGER NOT NULL
  );
  `,
  // 10: user-owned chat bots. Plaintext tokens are never stored.
  `
  CREATE TABLE bots (
    id INTEGER PRIMARY KEY,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    token_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bots_owner ON bots(owner_user_id);
  CREATE TABLE room_bots (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, bot_id)
  );
  `,
  // 11: per-room soundboard clips. Files live in DATA_DIR/sounds.
  `
  CREATE TABLE room_sounds (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX room_sounds_room ON room_sounds(room_id, created_at);
  `,
  // 12: account email. Nullable so existing rows stay valid. Unique only when set.
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  ALTER TABLE users ADD COLUMN email_lower TEXT;
  ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
  CREATE UNIQUE INDEX users_email_lower ON users(email_lower) WHERE email_lower IS NOT NULL;
  CREATE TABLE email_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email_lower TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    code_hash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX email_tokens_user ON email_tokens(user_id);
  CREATE INDEX email_tokens_code ON email_tokens(code_hash);
  `,
  // 13: TikTok Login Kit. Nullable so existing rows stay valid. Unique only when set.
  `
  ALTER TABLE users ADD COLUMN tiktok_open_id TEXT;
  CREATE UNIQUE INDEX users_tiktok_open_id ON users(tiktok_open_id) WHERE tiktok_open_id IS NOT NULL;
  `,
  // 14: one site-wide moderator bot. The value is a bot id, or the row is absent.
  `
  CREATE TABLE site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `,
  // 15: which bot posted a line. Null for people. Older rows stay null.
  `
  ALTER TABLE messages ADD COLUMN bot_id INTEGER;
  `,
  // 16: push-to-talk voice notes. Files live in DATA_DIR/voice; rows track uploader, room and the claiming message.
  `
  CREATE TABLE IF NOT EXISTS voice_notes (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    message_id TEXT,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    uploader_user_id INTEGER,
    uploader_devices TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS voice_notes_room ON voice_notes(room_id);
  CREATE INDEX IF NOT EXISTS voice_notes_message ON voice_notes(message_id);
  ALTER TABLE messages ADD COLUMN voice_id TEXT;
  ALTER TABLE messages ADD COLUMN voice_ms INTEGER;
  `,
  // 17: chat image uploads are tracked per room so they can be deleted with their message / room.
  //     Images uploaded before this migration have no row and are left alone.
  `
  CREATE TABLE IF NOT EXISTS chat_images (
    name TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    message_id TEXT,
    uploader_user_id INTEGER,
    uploader_devices TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_images_room ON chat_images(room_id);
  CREATE INDEX IF NOT EXISTS chat_images_message ON chat_images(message_id);
  `,
  // 18: all-time trivia leaderboard per room. Registered players only; guests are never stored.
  `
  CREATE TABLE IF NOT EXISTS trivia_scores (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS trivia_scores_room_points ON trivia_scores(room_id, points DESC);
  `,
  // 19: burn-after-reading messages. burn_ttl (seconds) marks one; burned_at is set when its content is wiped.
  `
  ALTER TABLE messages ADD COLUMN burn_ttl INTEGER;
  ALTER TABLE messages ADD COLUMN burned_at INTEGER;
  ALTER TABLE messages ADD COLUMN burn_recipients TEXT;
  CREATE INDEX IF NOT EXISTS messages_burn_live ON messages(burn_ttl) WHERE burn_ttl IS NOT NULL AND burned_at IS NULL;
  CREATE TABLE IF NOT EXISTS burn_views (
    message_id TEXT NOT NULL,
    viewer_key TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, viewer_key)
  );
  `,
  // 20: cosmetic activity badges. Counters per (user, stat); earned badges with time; optional pick of up to 3 to show.
  // Existing accounts get Early Bird; Social and Host are backfilled from friendships / owned rooms.
  `
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, stat)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS user_badges (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge TEXT NOT NULL,
    earned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, badge)
  ) WITHOUT ROWID;
  ALTER TABLE users ADD COLUMN shown_badges TEXT;
  INSERT OR IGNORE INTO user_badges (user_id, badge, earned_at) SELECT id, 'early', CAST(strftime('%s','now') AS INTEGER) * 1000 FROM users;
  INSERT OR IGNORE INTO user_stats (user_id, stat, value)
    SELECT uid, 'friends', COUNT(*) FROM (
      SELECT user_id AS uid FROM friendships WHERE status = 'accepted'
      UNION ALL SELECT peer_id AS uid FROM friendships WHERE status = 'accepted'
    ) GROUP BY uid;
  INSERT OR IGNORE INTO user_stats (user_id, stat, value)
    SELECT owner_user_id, 'rooms_created', COUNT(*) FROM rooms WHERE owner_user_id IS NOT NULL AND is_private = 0 GROUP BY owner_user_id;
  INSERT OR IGNORE INTO user_badges (user_id, badge, earned_at)
    SELECT user_id, 'social', CAST(strftime('%s','now') AS INTEGER) * 1000 FROM user_stats WHERE stat = 'friends' AND value >= 10;
  INSERT OR IGNORE INTO user_badges (user_id, badge, earned_at)
    SELECT user_id, 'host', CAST(strftime('%s','now') AS INTEGER) * 1000 FROM user_stats WHERE stat = 'rooms_created' AND value >= 5;
  `,
  // 21: private per-user message bookmarks. The search index (FTS5, when available) is built by ensureSearchIndex().
  `
  CREATE TABLE IF NOT EXISTS message_bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS message_bookmarks_user ON message_bookmarks(user_id, created_at);
  CREATE INDEX IF NOT EXISTS message_bookmarks_message ON message_bookmarks(message_id);
  `,
  // 22: scheduled room events + RSVPs. reminded_soon / reminded_start record sent (or skipped) reminders so restarts never re-send.
  `
  CREATE TABLE IF NOT EXISTS room_events (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    duration_min INTEGER,
    created_by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_nick TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    reminded_soon INTEGER,
    reminded_start INTEGER
  );
  CREATE INDEX IF NOT EXISTS room_events_room_start ON room_events(room_id, starts_at);
  CREATE INDEX IF NOT EXISTS room_events_pending ON room_events(starts_at) WHERE reminded_start IS NULL;
  CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id TEXT NOT NULL REFERENCES room_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('going','maybe','no')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, user_id)
  ) WITHOUT ROWID;
  `,
  // 23: room moderators appointed by the room owner, and room-scoped chat mutes.
  `
  CREATE TABLE IF NOT EXISTS room_mods (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_mutes (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_key TEXT, ip TEXT, device_id TEXT, nick TEXT,
    created_by TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS room_mutes_room ON room_mutes(room_id, expires_at);
  `,
  // 24: Web Push subscriptions (one row per browser endpoint).
  `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
  `,
  // 25: link previews. link_previews caches fetched metadata by URL (with TTL); message_previews attaches one to a message.
  `
  CREATE TABLE IF NOT EXISTS link_previews (
    url TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    ok INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'page',
    title TEXT, description TEXT, image_url TEXT, site_name TEXT,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS link_previews_fetched ON link_previews(fetched_at);
  CREATE TABLE IF NOT EXISTS message_previews (
    message_id TEXT PRIMARY KEY,
    preview_id TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  `,
  // 26: polls (single choice). voter_key is u:<account> or d:<device> for guests.
  `
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    created_by_user INTEGER,
    created_by_key TEXT NOT NULL,
    created_by_nick TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closes_at INTEGER,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS polls_open ON polls(closes_at) WHERE closed_at IS NULL;
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    voter_key TEXT NOT NULL,
    option INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, voter_key)
  ) WITHOUT ROWID;
  `,
  // 27: profile bio (280 chars, markdown-lite).
  `
  ALTER TABLE users ADD COLUMN bio TEXT;
  `,
  // 28: custom room thumbnail (random id -> DATA_DIR/room-thumbs/<id>.webp; a new id per upload).
  `
  ALTER TABLE rooms ADD COLUMN thumb_id TEXT;
  ALTER TABLE rooms ADD COLUMN thumb_at INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS rooms_thumb_id ON rooms(thumb_id) WHERE thumb_id IS NOT NULL;
  `,
  // 29: batch 3 - room category/tags, announcement banner, scheduled messages, room stats, custom emotes.
  `
  ALTER TABLE rooms ADD COLUMN category TEXT;
  ALTER TABLE rooms ADD COLUMN tags TEXT;
  ALTER TABLE rooms ADD COLUMN announcement TEXT;
  ALTER TABLE rooms ADD COLUMN announcement_at INTEGER;
  ALTER TABLE rooms ADD COLUMN announcement_by TEXT;
  CREATE TABLE IF NOT EXISTS room_schedules (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    repeat TEXT NOT NULL,
    next_at INTEGER NOT NULL,
    tz TEXT,
    created_by_user INTEGER,
    created_by_nick TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_posted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS room_schedules_room ON room_schedules(room_id);
  CREATE INDEX IF NOT EXISTS room_schedules_next ON room_schedules(next_at);
  CREATE TABLE IF NOT EXISTS announce_messages (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    schedule_id TEXT,
    by_nick TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_stats_hourly (
    room_id TEXT NOT NULL,
    hour INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    peak INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, hour)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_stats_daily (
    room_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    guests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, day)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_visitors (
    room_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, day, user_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_emotes (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS room_emotes_name ON room_emotes(room_id, name);
  `,
  // 30: moderation queue: grouped targets, reasons, snapshots, claims, auto-hide, user notices
  `
  ALTER TABLE reports ADD COLUMN target_kind TEXT;
  ALTER TABLE reports ADD COLUMN target_key TEXT;
  ALTER TABLE reports ADD COLUMN category TEXT;
  ALTER TABLE reports ADD COLUMN reporter_note TEXT;
  ALTER TABLE reports ADD COLUMN snapshot TEXT;
  ALTER TABLE reports ADD COLUMN private_kind TEXT;
  ALTER TABLE reports ADD COLUMN claimed_by TEXT;
  ALTER TABLE reports ADD COLUMN claimed_by_id INTEGER;
  ALTER TABLE reports ADD COLUMN claimed_at INTEGER;
  ALTER TABLE reports ADD COLUMN updated_at INTEGER;
  ALTER TABLE reports ADD COLUMN resolution TEXT;
  ALTER TABLE reports ADD COLUMN notify_reporter INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE reports ADD COLUMN reporter_notified_at INTEGER;
  CREATE INDEX IF NOT EXISTS reports_target ON reports(target_key, status);
  CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_user_id, created_at);
  CREATE INDEX IF NOT EXISTS reports_room ON reports(room_id, status);
  UPDATE reports SET target_kind = 'message', target_key = 'm:' || message_id WHERE target_key IS NULL AND message_id IS NOT NULL;
  UPDATE reports SET target_kind = 'user', target_key = 'u:' || COALESCE(CAST(target_user_id AS TEXT), 'n:' || lower(COALESCE(target_nick, '')), CAST(id AS TEXT)) WHERE target_key IS NULL;
  UPDATE reports SET category = 'other' WHERE category IS NULL;
  CREATE TABLE IF NOT EXISTS hidden_messages (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    report_id INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS user_notices (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS user_notices_user ON user_notices(user_id, delivered_at)
  `,
  // 31: smarter lobby - room presence privacy for friends, server copy of the block list, recently visited rooms.
  `
  ALTER TABLE users ADD COLUMN show_room INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE IF NOT EXISTS user_blocks (
    user_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS user_blocks_blocked ON user_blocks(blocked_id);
  CREATE TABLE IF NOT EXISTS recent_rooms (
    user_id INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    visited_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS recent_rooms_user ON recent_rooms(user_id, visited_at)
  `,
  // 32: custom room icon for the room rail / header (random id -> DATA_DIR/room-icons/<id>.webp; a new id per upload).
  `
  ALTER TABLE rooms ADD COLUMN icon_id TEXT;
  ALTER TABLE rooms ADD COLUMN icon_at INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS rooms_icon_id ON rooms(icon_id) WHERE icon_id IS NOT NULL
  `,
  // 33: room invite links (/i/<code>), one counted use per account, and the "room mods can invite" room setting.
  `
  CREATE TABLE IF NOT EXISTS room_invites (
    code TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    created_by INTEGER,
    created_by_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    skip_password INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS room_invites_room ON room_invites(room_id, created_at);
  CREATE INDEX IF NOT EXISTS room_invites_creator ON room_invites(room_id, created_by, is_default);
  CREATE TABLE IF NOT EXISTS room_invite_uses (
    code TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (code, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS room_invite_uses_user ON room_invite_uses(user_id);
  ALTER TABLE rooms ADD COLUMN mods_can_invite INTEGER NOT NULL DEFAULT 0
  `,
  // 34: per-account camera quality preset (video quality controls)
  `
  ALTER TABLE users ADD COLUMN video_quality TEXT
  `,
  // 35: batch 4a: message edit history (staff view) and stage mode
  `
  CREATE TABLE IF NOT EXISTS message_edits (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    text TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    editor_user_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS message_edits_msg ON message_edits(message_id, edited_at);
  ALTER TABLE rooms ADD COLUMN stage_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN stage_cap INTEGER NOT NULL DEFAULT 0
  `,
  // 36: bot room joins survive a restart. A row means "this bot joined this room and has not left";
  // the allow list (room_bots) is still checked on every restore and every post.
  `
  CREATE TABLE IF NOT EXISTS bot_room_joins (
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, room_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS bot_room_joins_room ON bot_room_joins(room_id)
  `,
  // 37: per-room notification level + push quiet hours, and room themes (banner, accent color, welcome message).
  `
  CREATE TABLE IF NOT EXISTS room_notify (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    level TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS room_notify_room ON room_notify(room_id, level);
  CREATE TABLE IF NOT EXISTS push_quiet (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    tz TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE rooms ADD COLUMN theme_banner_id TEXT;
  ALTER TABLE rooms ADD COLUMN theme_accent TEXT;
  ALTER TABLE rooms ADD COLUMN welcome_text TEXT
  `,
  // 38: interface theme picked by the account (null = Dark, the default).
  `
  ALTER TABLE users ADD COLUMN ui_theme TEXT
  `,
  // 39: batch A - per-account read markers, mentions inbox, persistent whispers (members-only, pruned by age).
  `
  CREATE TABLE IF NOT EXISTS room_reads (
    user_id INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    read_ts INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  );
  CREATE TABLE IF NOT EXISTS mention_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_nick TEXT NOT NULL,
    ts INTEGER NOT NULL,
    read_at INTEGER,
    UNIQUE (user_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS mention_inbox_user ON mention_inbox(user_id, ts);
  CREATE TABLE IF NOT EXISTS whisper_messages (
    id TEXT PRIMARY KEY,
    whisper_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    from_user_id INTEGER,
    from_nick TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS whisper_messages_ts ON whisper_messages(ts);
  CREATE TABLE IF NOT EXISTS whisper_members (
    message_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS whisper_members_user ON whisper_members(user_id)
  `,
  // 40: batch B - per-room word / link filters (Meowington), scheduled banner posts, per-account link preview toggle.
  `
  CREATE TABLE IF NOT EXISTS room_filters (
    room_id TEXT PRIMARY KEY,
    words TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT 'off',
    allow_domains TEXT NOT NULL DEFAULT '',
    updated_at INTEGER,
    updated_by TEXT
  );
  ALTER TABLE room_schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
  ALTER TABLE users ADD COLUMN link_previews INTEGER NOT NULL DEFAULT 1
  `,
  // 41: batch C - voice rooms (audio only).
  `
  ALTER TABLE rooms ADD COLUMN voice INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE room_schedules ADD COLUMN poll TEXT;
  ALTER TABLE users ADD COLUMN banner_id TEXT;
  ALTER TABLE users ADD COLUMN profile_links TEXT;
  ALTER TABLE users ADD COLUMN now_playing TEXT;
  ALTER TABLE users ADD COLUMN now_playing_at INTEGER
  `,
  // 42: batch D - XP and levels.
  `
  ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN xp_hidden INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN xp_day INTEGER;
  ALTER TABLE users ADD COLUMN xp_today INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN xp_last_at INTEGER;
  ALTER TABLE users ADD COLUMN xp_last_key TEXT;
  CREATE TABLE IF NOT EXISTS ban_appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ban_id INTEGER NOT NULL UNIQUE,
    user_id INTEGER,
    username TEXT,
    ip TEXT NOT NULL,
    device_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    decided_by TEXT,
    decided_at INTEGER,
    decision_note TEXT
  );
  CREATE INDEX IF NOT EXISTS ban_appeals_status ON ban_appeals(status, created_at);
  CREATE TABLE IF NOT EXISTS user_totp (
    user_id INTEGER PRIMARY KEY,
    secret TEXT NOT NULL,
    enabled_at INTEGER,
    last_step INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS user_recovery_codes_user ON user_recovery_codes(user_id);
  ALTER TABLE sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0
  `,
  // 43: batch E - passkeys, room-ban appeals, encrypted TOTP secrets, synced drafts.
  `
  CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cred_id TEXT NOT NULL UNIQUE,
    public_jwk TEXT NOT NULL,
    alg INTEGER NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    removed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS user_passkeys_user ON user_passkeys(user_id);
  CREATE TABLE IF NOT EXISTS room_ban_appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_ban_id INTEGER NOT NULL UNIQUE,
    room_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    decided_by TEXT,
    decided_at INTEGER,
    decision_note TEXT
  );
  CREATE INDEX IF NOT EXISTS room_ban_appeals_room ON room_ban_appeals(room_id, status)
  `,
];

/**
 * Migrations from 16 on may meet a database where an earlier build already created some of their
 * tables or columns. They use IF NOT EXISTS / OR IGNORE, and an ADD COLUMN that already exists is skipped.
 */
const IDEMPOTENT_FROM = 15;
function runIdempotent(sql: string, schemaOnly = false) {
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (schemaOnly && !/^(CREATE|ALTER)\b/i.test(stmt)) continue;
    try {
      db.exec(stmt);
    } catch (err) {
      if (/duplicate column name/i.test(String((err as Error).message))) continue;
      throw err;
    }
  }
}

/** Apply pending migrations (optionally only up to `upTo`, used by the migration test). */
export function migrate(upTo = MIGRATIONS.length) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < Math.min(upTo, MIGRATIONS.length); v++) {
    db.exec('BEGIN');
    try {
      if (v < IDEMPOTENT_FROM) db.exec(MIGRATIONS[v]);
      else runIdempotent(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      console.log(`[db] applied migration ${v + 1}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (upTo >= MIGRATIONS.length) { ensureFeatureSchema(); ensureSearchIndex(); }
}

/** True once the FTS5 message index exists. Search falls back to LIKE when FTS5 is missing from this SQLite build. */
export let ftsAvailable = false;
/**
 * Message search index. FTS5 is optional (not every SQLite build has it), so it lives outside MIGRATIONS:
 * a missing module must not stop the server. Triggers keep it in sync with every write path (send, edit,
 * delete, purge, burn, prune). Burn messages, deleted rows and voice notes are never indexed.
 * Statements are run whole (trigger bodies contain semicolons), each guarded by IF NOT EXISTS.
 */
export function ensureSearchIndex() {
  ftsAvailable = false;
  if (process.env.SEARCH_DISABLE_FTS === '1') return;
  const indexable = (r: string) => `${r}.deleted = 0 AND ${r}.burn_ttl IS NULL AND ${r}.voice_id IS NULL`;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, room_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages WHEN ${indexable('new')} BEGIN
      INSERT INTO messages_fts(rowid, text, room_id) VALUES (new.rowid, new.text, new.room_id); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text, deleted, burned_at, burn_ttl ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, text, room_id) SELECT new.rowid, new.text, new.room_id WHERE ${indexable('new')}; END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid; END`);
    // Backfill rows written before the index existed (or while it was missing). Cheap: history is capped per room.
    db.exec(`INSERT INTO messages_fts(rowid, text, room_id) SELECT m.rowid, m.text, m.room_id FROM messages m
      WHERE ${indexable('m')} AND m.rowid NOT IN (SELECT rowid FROM messages_fts)`);
    ftsAvailable = true;
  } catch (err) {
    console.error('[db] FTS5 search index unavailable, using LIKE search:', (err as Error).message);
  }
}

/**
 * The live database can carry a user_version from another branch's numbering, so migrations 16+ may be
 * skipped by number. Re-apply their table / column / index statements (never their data inserts) every
 * start; each is IF NOT EXISTS or a tolerated duplicate ADD COLUMN, so this is a no-op once present.
 */
export function ensureFeatureSchema() {
  db.exec('BEGIN');
  try {
    for (let v = IDEMPOTENT_FROM; v < MIGRATIONS.length; v++) runIdempotent(MIGRATIONS[v], true);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const cache = new Map<string, StatementSync>();
/** Cached prepared statement. */
export function q(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (err) { db.exec('ROLLBACK'); throw err; }
}
