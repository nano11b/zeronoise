# zeronoise native apps

iPhone, iPad, Android, and Windows apps for the live site at `https://chat.nano11bravo.com`. The shells are in `native/`. They do not ship a second copy of the React app.

## Approach

**Capacitor 8** for iOS and Android. **Electron 44** for Windows.

Each app loads the live site in a real webview (WKWebView, Android WebView, Electron). Username/password login, guests, Socket.IO, and WebRTC then behave like the website:

- The session cookie is `HttpOnly; SameSite=Lax`. A bundled SPA on `capacitor://localhost` or `file://` would call the API cross-site, so the browser would not send that cookie and the server would reject the foreign `Origin`. Pointing the webview at `https://chat.nano11bravo.com` keeps every request first-party. No `CORS_ORIGIN` change and no `SameSite=None` change.
- Cookies persist in the webview store (WKWebsiteDataStore, Android CookieManager, Electron's default session). Signing in on the phone stays signed in.
- Camera and microphone go through the webview's `getUserMedia`. Android already asks for the runtime permission inside Capacitor's WebChromeClient. iOS needs the usage strings in `Info.plist`, which are already set. iOS also sets `AVAudioSession` to play-and-record so room audio is heard with the ringer switch on silent.
- Links that leave `chat.nano11bravo.com` open in the system browser. Capacitor does that by default. Electron does it in `setWindowOpenHandler` / `will-navigate`.
- Google rejects OAuth inside an embedded webview (`disallowed_useragent`). Discord is the same kind of flow. The shells intercept `/api/auth/google` and `/api/auth/discord` and open them in Safari / Chrome Custom Tabs / the desktop browser. See the server section below. Do not spoof a Chrome user agent to sneak past Google.
- Windows screen share uses Electron's `desktopCapturer` and a picker (entire screen or a window). `getDisplayMedia` in the page waits for that picker. The website still drops entire-screen system audio on purpose; video share works.

Tauri was the other desktop option. Electron is the one that already has a Windows screen-share path and a cookie store that matches the website.

The live URL is `native/config.json`. `native/desktop/config.json` must stay a copy of it (a unit test checks). Mobile reads the URL from `capacitor.config.ts`, which is copied into the native project by `npx cap sync`.

## Server change to deploy

Browser login is unchanged. Google and Discord inside the apps need one additive path, already in this tree:

| File | What |
| --- | --- |
| `server/nativeHandoff.ts` | 60-second single-use token. Only a hash is kept, in memory. |
| `server/http.ts` | `?client=native&nonce=<challenge>` on the existing Google and Discord start routes. The callback redirects to `camchat://auth` instead of `/`. `GET /api/auth/native?token=&verifier=` sets the session cookie. |
| `server/env.ts` | Optional `NATIVE_AUTH_SCHEME` (default `camchat`). |

`deploy/camchat-upgrade.sh` does not need an edit. The next normal upgrade ships this. There is no new Google or Discord redirect URI: the provider still returns to `https://chat.nano11bravo.com/api/auth/.../callback`, and only then does the server redirect to `camchat://auth`.

No CORS change. Do not set `SameSite=None`.

The handoff assumes one Node process, which is how the Debian service runs. A second process would not see the token.

Until that build is deployed, password and guest login work in the apps. Google and Discord will finish in the system browser and will not sign the app in.

`npm run test:native` covers the handoff, including that a stolen `camchat://` URL cannot be redeemed without the verifier that stayed on the device.

## Android

Needs JDK 21 and Android SDK 36 (compileSdk 36, minSdk 24).

The public file is a release APK, version 1.2.1 (`zeronoise-1.2.1.apk`). Gradle signs it only when these are set. Do not commit the keystore or the passwords. Use the same keystore as 1.1.0 or Android will not update over that install.

```bash
export ZERONOISE_KEYSTORE=/path/to/zeronoise-release.jks
export ZERONOISE_KEYSTORE_PASSWORD='...'
export ZERONOISE_KEY_ALIAS=zeronoise
export ZERONOISE_KEY_PASSWORD='...'
cd native/mobile
npm ci
npx cap sync android
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleRelease
```

Output: `native/mobile/android/app/build/outputs/apk/release/app-release.apk`. Copy that to `downloads/zeronoise-1.2.1.apk` for the download page. `./gradlew bundleRelease` produces the `.aab` Play Console wants, with the same key.

On launch, and again every six hours, the app reads `GET /api/updates` (not cached). If that APK is newer and the sha256 matches, it asks once, then Android's installer asks the user to confirm. `REQUEST_INSTALL_PACKAGES` and a FileProvider are how the file is handed over. A sideloaded app cannot install silently.

Anyone who installed an earlier APK has to uninstall it first. The release key is not the key that signed that file, and Android will not update across the two signatures.

`assembleDebug` still builds a local test APK. It is not the public download.

The manifest requests `CAMERA`, `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS`, and registers `camchat://auth`.

## iOS (Mac only)

This environment is Linux, so the Xcode project is generated and committed but not compiled. Capacitor 8 uses Swift Package Manager, not CocoaPods. Do not run `pod install`.

On a Mac with Xcode 16 or newer (iOS 15 deployment target):

```bash
cd native/mobile
npm ci
npx cap sync ios
open ios/App/App.xcodeproj
```

The first open resolves the `CapApp-SPM` package from GitHub, so the Mac needs network. Then:

1. Select the App target, Signing & Capabilities, and choose the Apple Developer team. Bundle id is `com.nano11bravo.camchat`.
2. Product, Archive, then Distribute App.
3. `Info.plist` already has `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, and the `camchat` URL scheme.

`AppDelegate.swift` sets the audio session. `CamChatShell.swift` is the OAuth handoff. `SceneDelegate.swift` uses `CamChatViewController` instead of the stock bridge controller.

There is no iOS binary yet. When there is one, on launch it should read the same `GET /api/updates` manifest and, if `ios.storeUrl` is set and the store version is newer, show a "new version" prompt that opens the App Store or TestFlight. iOS will not install that update inside the app. The version comparison lives in `shared/updates.ts`.

## Windows

Needs Node 22. The build below was produced on Linux with `electron-builder` (no Wine). It is a portable zip, not an installer.

```bash
cd native/desktop
npm ci
npm test
npm run dist:win
```

Output: `native/desktop/dist-builder/zeronoise-1.2.1-setup.exe` (installer) and `zeronoise-1.2.1-win.zip` (portable). The installer is what later versions replace. The zip cannot replace itself.

The installed app calls `GET /api/updates`, downloads `zeronoise-<version>-setup.exe`, checks sha256, and opens the installer. It is unsigned, so the check is the checksum, not Authenticode. `GET /api/updates/win/latest.yml` is the same release in the electron-updater shape (sha512, `Cache-Control: no-store`) if a signed build wants that feed later.

`CAMCHAT_URL=http://127.0.0.1:3000 npm start` points a local run at a dev server. Do not bake that URL into a release.

An NSIS installer (`npm run dist:win:installer`) needs Wine on Linux, or a Windows machine. Code signing is separate: set `CSC_LINK` to a `.pfx` and `CSC_KEY_PASSWORD` before `electron-builder`. Without an Authenticode certificate, SmartScreen will warn on first launch. That is expected for an unsigned build.

The packaged app registers the `camchat://` protocol for the current user so the system browser can return from Google sign-in.

## Accounts and keys the owner must provide

| Store | What |
| --- | --- |
| Apple Developer Program | Paid membership. Create the App ID `com.nano11bravo.camchat`. Xcode manages the signing certificate and provisioning profile once a team is selected. |
| Google Play Console | One-time registration. Upload an AAB signed with your upload key. Play App Signing holds the app signing key. |
| Windows | Optional Authenticode certificate (OV or EV) from a public CA. EV reduces SmartScreen warnings. There is no Microsoft store listing in this setup; this is a direct download. |
| Google Cloud / Discord | No new client and no new redirect URI. The existing web OAuth clients stay as they are. |

## App Store guideline 4.2

Apple rejects a website wrapped in a webview when the native app adds nothing. This build is still mostly the website, on purpose, so login and WebRTC match production. The native pieces that are real today:

- System permission prompts for camera and microphone, with purpose strings.
- Audio session so voice plays back correctly on iPhone.
- Google and Discord sign-in in the system browser, then a return into the app. That flow cannot be done on the website alone inside a webview.
- Outside links leave the app.
- Branded icon and splash.
- On Windows, a native screen picker.

A review note should say the app is the live room client and that camera, microphone, and sign-in are integrated natively. That may still not be enough. The additions most likely to matter later, not built here:

- Push notifications for mentions and incoming calls.
- CallKit / ConnectionService so a voice session behaves like a call.
- A share sheet for room links.
- Universal links (`https://chat.nano11bravo.com/...`) instead of the `camchat://` scheme, once the Apple Team ID exists. That also stops another app on the device from claiming the scheme.
- Background audio only if a real call-style session needs it. Do not enable the background mode just to have a checkbox.

## Public download page

`https://chat.nano11bravo.com/download` lists Windows, Android, and iOS (coming soon). The server only sends a file that is actually in `DATA_DIR/downloads` (`/var/lib/camchat/downloads` in production), with `Content-Disposition: attachment`. The login screen and the lobby link there as "Get the app".

`deploy/camchat-upgrade.sh` copies `downloads/` from the tarball into that directory, including `releases.json`. For each sha256 sidecar, `/home/manager/camchat-downloads/` may contain the whole file or `part00` onward (`zeronoise-1.2.1-setup.exe`, `zeronoise-1.2.1-win.zip`). The script checks the hash and installs the file. It never deletes files already in the data directory. Re-running the script is safe. A failed health check still rolls the app back; binaries already copied are left in place.

`GET /api/updates` is the version the download page shows. It is `Cache-Control: no-store`. The files themselves keep the version in the filename, so a cached `/download` copy cannot be confused with the next release. The shells load `https://chat.nano11bravo.com`, so web UI changes ship without an app update. An app update is only for the shell (installer, permissions, this updater).

## What was not verified here

- The iOS project was not compiled (no Xcode on this machine).
- Camera, microphone, and a real room were not exercised on a phone or on Windows. The release APK and the Windows zip were produced; they were not installed on those devices.
- Google and Discord sign-in in the apps need the server handoff above to be deployed first.
