# Signed releases

Packages are signed with an **ed25519 key that exists only on the release PC** (`C:\Users\nano\.camchat-release-key`).
The server only holds the public half, in `/etc/camchat-release.pub` (root-owned, so the `manager` account cannot swap it).
`camchat-upgrade.sh` verifies `camchat.tar.gz.sig` with `ssh-keygen -Y verify` (namespace `zeronoise-release`)
before it extracts anything. A missing, wrong-key, wrong-namespace, or tampered signature is refused (exit 4) and nothing changes.

**Transition:** until `/etc/camchat-release.pub` exists, the script still accepts the current unsigned
`zeronoise-release/1` marker (MANIFEST + RELEASE.json lock) and prints `TRANSITION MODE`. Once the key file is installed,
every package must be signed. To go back, remove nothing: just keep signing.

## One-time setup (on the PC, PowerShell)
1. `ssh-keygen -t ed25519 -C zeronoise-release -f $env:USERPROFILE\.camchat-release-key`
   (choose a passphrase at the hidden prompt; never paste it anywhere; back up the key file offline).
2. `scp -i $env:USERPROFILE\.ssh\camchat_deploy $env:USERPROFILE\.camchat-release-key.pub manager@10.0.10.55:/home/manager/camchat-release.pub`
   (the `.pub` file only).
3. `ssh -t -i $env:USERPROFILE\.ssh\camchat_deploy manager@10.0.10.55 "sudo install -o root -g root -m 644 /home/manager/camchat-release.pub /etc/camchat-release.pub && ssh-keygen -lf /etc/camchat-release.pub"`
   and check the fingerprint matches `ssh-keygen -lf $env:USERPROFILE\.camchat-release-key.pub` on the PC.

## Each release
1. Copy the tarball to the PC (e.g. `C:\Users\nano\camchat-release\camchat.tar.gz`) and check its sha256 against the report.
2. `powershell -ExecutionPolicy Bypass -File deploy\sign-release.ps1 -Tarball C:\Users\nano\camchat-release\camchat.tar.gz`
   (enter the passphrase; writes `camchat.tar.gz.sig` and verifies it).
3. `scp -i $env:USERPROFILE\.ssh\camchat_deploy C:\Users\nano\camchat-release\camchat.tar.gz.sig manager@10.0.10.55:/home/manager/`
4. `ssh -t -i $env:USERPROFILE\.ssh\camchat_deploy manager@10.0.10.55 'sudo bash /home/manager/camchat-upgrade.sh'`
   — look for `signature OK`.

## Rollback
`sudo bash /home/manager/camchat-upgrade.sh --rollback` restores the newest `/opt/camchat.bak-*` and the database copy
taken by that upgrade (`/var/lib/camchat/upgrade-backups/camchat.db.pre-<stamp>`). Nothing is deleted: the current app goes
to `/opt/camchat.rolledback-<now>` and the current database to `upgrade-backups/camchat.db.rolledback-<now>`.
`--keep-db` rolls back code only. `ROLLBACK_TO=/opt/camchat.bak-<stamp>` picks an older one.
Backups made before this version have no database copy; for those, rollback keeps the current database (migrations are additive).
