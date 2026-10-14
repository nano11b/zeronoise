# Restoring a zeronoise (CamChat) backup

The server makes backups by itself: nightly at about 04:15 server time, and once about 10 minutes after
startup when the newest backup is more than 24 hours old. Site admins can also press **Back up now** in the mod
panel (**Backups** tab, limit one every 10 minutes). Archives live in `/var/lib/camchat/backups/`, named
`camchat-YYYYMMDD-HHMMSS.tar.gz`, mode 0640. The newest 7 are kept.

Each archive contains:

| path in archive | what |
| --- | --- |
| `manifest.json` | build, DB `user_version`, sha256 + size of the DB snapshot, file counts |
| `camchat.db` | consistent SQLite snapshot (`VACUUM INTO`, no `-wal`/`-shm` needed) |
| `avatars/ room-thumbs/ room-emotes/ voice/ sounds/ uploads/` | user uploads (any folder that was empty may be missing) |
| `vapid.json` | Web Push keys (only if the server generated them) |

**Not** included: `downloads/` (app installers you uploaded yourself; re-copy them), link-preview and radio
caches (rebuilt automatically), `.session_secret` (the live server uses `SESSION_SECRET` from
`/etc/camchat.env`; if a server ever ran on the generated file and it is lost, everyone just signs in again),
and older backups.

Restore is **manual on purpose**. It replaces all chat data with the backup's content; anything newer is lost
(the steps below keep a copy of the current data first).

## Steps (as root on the server)

Set the archive you want (copy it to the server first if you downloaded it from the mod panel):

```bash
sudo -i
B=/var/lib/camchat/backups/camchat-YYYYMMDD-HHMMSS.tar.gz   # <- the backup to restore
DATA=/var/lib/camchat
TS=$(date +%Y%m%d-%H%M%S)
```

1. **Extract to a temp dir and verify the manifest** (do this before stopping anything):

   ```bash
   R=$(mktemp -d /root/camchat-restore-XXXXXX)
   tar -xzf "$B" -C "$R"
   cat "$R/manifest.json"
   want=$(node -e 'console.log(require(process.argv[1]).db.sha256)' "$R/manifest.json")
   have=$(sha256sum "$R/camchat.db" | cut -d' ' -f1)
   [ "$want" = "$have" ] && echo "DB checksum OK" || { echo "CHECKSUM MISMATCH - stop here"; exit 1; }
   node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("PRAGMA integrity_check").get(), d.prepare("SELECT COUNT(*) n FROM users").get())' "$R/camchat.db"
   ```

   `integrity_check` must print `ok`. If the checksum does not match, do not continue; pick another archive.

2. **Stop the service:**

   ```bash
   systemctl stop camchat.service
   ```

3. **Keep a copy of the current data** (DB including WAL files, plus the folders that will be replaced):

   ```bash
   KEEP=/var/lib/camchat-before-restore-$TS
   mkdir -p "$KEEP"
   for f in camchat.db camchat.db-wal camchat.db-shm vapid.json; do [ -e "$DATA/$f" ] && mv "$DATA/$f" "$KEEP/"; done
   for d in avatars room-thumbs room-emotes voice sounds uploads; do [ -e "$DATA/$d" ] && mv "$DATA/$d" "$KEEP/"; done
   ```

   (`backups/`, `downloads/` and everything else in `$DATA` stay where they are.)

4. **Put the backup in place:**

   ```bash
   cp "$R/camchat.db" "$DATA/camchat.db"
   for d in avatars room-thumbs room-emotes voice sounds uploads; do
     if [ -d "$R/$d" ]; then cp -a "$R/$d" "$DATA/$d"; else mkdir -p "$DATA/$d"; fi
   done
   [ -f "$R/vapid.json" ] && cp "$R/vapid.json" "$DATA/vapid.json"
   ```

   If the backup has no `vapid.json` but the old data had one, and `/etc/camchat.env` does not set
   `VAPID_PUBLIC_KEY`, copy it back so existing push subscriptions keep working:
   `[ ! -f "$DATA/vapid.json" ] && [ -f "$KEEP/vapid.json" ] && cp "$KEEP/vapid.json" "$DATA/"`

5. **Fix ownership and modes:**

   ```bash
   chown -R camchat:camchat "$DATA/camchat.db" "$DATA"/avatars "$DATA"/room-thumbs "$DATA"/room-emotes "$DATA"/voice "$DATA"/sounds "$DATA"/uploads
   [ -f "$DATA/vapid.json" ] && chown camchat:camchat "$DATA/vapid.json" && chmod 600 "$DATA/vapid.json"
   chmod 640 "$DATA/camchat.db"
   chmod 750 "$DATA"/avatars "$DATA"/room-thumbs "$DATA"/room-emotes "$DATA"/voice "$DATA"/sounds "$DATA"/uploads
   ```

6. **Start the service and check health:**

   ```bash
   systemctl start camchat.service
   sleep 3
   systemctl --no-pager status camchat.service | head -5
   curl -s http://127.0.0.1:3000/api/health; echo     # use the PORT from the unit if it is not 3000
   journalctl -u camchat.service -n 50 --no-pager
   ```

   Health must say `"ok":true,"db":true`. A backup from an older build is fine: the server applies any newer
   migrations on start (look for `[db] applied migration` lines).

7. **Clean up** when everything works (keep `$KEEP` for a few days in case you need to go back):

   ```bash
   rm -rf "$R"
   # later: rm -rf /var/lib/camchat-before-restore-<timestamp>
   ```

## Going back (undo a restore)

```bash
systemctl stop camchat.service
for f in camchat.db camchat.db-wal camchat.db-shm vapid.json; do rm -f "$DATA/$f"; [ -e "$KEEP/$f" ] && mv "$KEEP/$f" "$DATA/"; done
for d in avatars room-thumbs room-emotes voice sounds uploads; do rm -rf "$DATA/$d"; [ -e "$KEEP/$d" ] && mv "$KEEP/$d" "$DATA/"; done
systemctl start camchat.service
```

## Copying backups off the server

Backups on the same disk do not protect against losing the disk. Download one from the mod panel now and
then, or pull them, for example:
`rsync -a manager@SERVER:/var/lib/camchat/backups/ ./camchat-backups/` (the files are group `camchat`; the
reading account needs to be in that group or use sudo).

## Settings (optional, in `/etc/camchat.env`)

- `BACKUP_HOUR` (0-23, default 4) and `BACKUP_MINUTE` (0-59, default 15): nightly time, server local time.
- `BACKUP_DISABLED=1`: no automatic backups (Back up now still works).

A run is skipped and logged (`[backup] aborted`) when less than 2 GB is free under the data directory, or
when the backup could use more than 30% of the free space. Nothing is deleted in that case. A failure logs
`[backup] failed` and never stops the server. `/api/health` shows `lastBackupAt` and `lastBackupOk`.
