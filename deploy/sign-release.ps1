# Sign a zeronoise release on the release PC. The private key never leaves this PC and is never printed.
# One-time setup (asks for a passphrase in a hidden prompt):
#   ssh-keygen -t ed25519 -C zeronoise-release -f $env:USERPROFILE\.camchat-release-key
# Then for each release:
#   powershell -ExecutionPolicy Bypass -File deploy\sign-release.ps1 -Tarball C:\path\camchat.tar.gz
# Writes camchat.tar.gz.sig next to the tarball and checks it against the public key.
param(
  [Parameter(Mandatory = $true)][string]$Tarball,
  [string]$Key = "$env:USERPROFILE\.camchat-release-key"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Tarball)) { throw "no tarball at $Tarball" }
if (-not (Test-Path $Key)) { throw "no release key at $Key (create it with ssh-keygen, see the top of this file)" }
if (-not (Test-Path "$Key.pub")) { throw "no public key at $Key.pub" }
$sig = "$Tarball.sig"
if (Test-Path $sig) { Rename-Item $sig ("$sig.old-" + (Get-Date -Format yyyyMMdd-HHmmss)) }
ssh-keygen -Y sign -f $Key -n zeronoise-release $Tarball
if ($LASTEXITCODE -ne 0) { throw "signing failed" }
$pub = (Get-Content "$Key.pub" -Raw).Trim().Split(' ')
$allowed = New-TemporaryFile
"zeronoise-release namespaces=`"zeronoise-release`" $($pub[0]) $($pub[1])" | Set-Content -Encoding ascii $allowed
cmd /c "ssh-keygen -Y verify -f `"$allowed`" -I zeronoise-release -n zeronoise-release -s `"$sig`" < `"$Tarball`""
$ok = $LASTEXITCODE -eq 0
Remove-Item $allowed
if (-not $ok) { throw "the new signature did not verify" }
Write-Host "Signed: $sig"
Write-Host ("Tarball sha256: " + (Get-FileHash $Tarball -Algorithm SHA256).Hash.ToLower())
Write-Host ("Key fingerprint: " + (ssh-keygen -lf "$Key.pub"))
