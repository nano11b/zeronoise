import { BRAND_NAME } from '../shared/config';
import { CONTACT_EMAIL } from './env';

const UPDATED = 'October 7, 2026';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Shown only when CONTACT_EMAIL is a plain address. Otherwise people ask a moderator. */
function contactBlock(): string {
  const email = CONTACT_EMAIL;
  if (email) {
    const safe = esc(email);
    return `<p>Questions about these pages: <a href="mailto:${safe}">${safe}</a>.</p>`;
  }
  return `<p>We do not have a public contact address. To ask a question or request a change to your account, contact a moderator in the app.</p>`;
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · ${esc(BRAND_NAME)}</title>
  <meta name="description" content="${esc(title)} for ${esc(BRAND_NAME)}.">
  <meta name="theme-color" content="#030605">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      background: radial-gradient(900px 480px at 50% -10%, rgb(57 255 20 / .06), transparent 55%), #030605;
      color: #c8ffc8;
      font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    }
    a { color: #39ff14; }
    .page { width: min(42rem, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 72px; }
    .mark { height: 100px; width: auto; display: block; }
    h1 { margin: 18px 0 6px; font-size: 28px; font-weight: 650; letter-spacing: 0; color: #e7ffe7; }
    h2 { margin: 28px 0 8px; font-size: 16px; font-weight: 650; color: #e7ffe7; }
    p, li { color: #c8ffc8; }
    .updated { margin: 0 0 8px; color: #8fdb9a; font-size: 13px; }
    ul { margin: 8px 0; padding-left: 1.2em; }
    li { margin: 0 0 8px; }
    .nav { margin: 28px 0 0; color: #8fdb9a; font-size: 14px; }
    @media (max-width: 640px) {
      .page { padding-top: 24px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <a href="/"><img class="mark" src="/logo-lockup.png" alt="${esc(BRAND_NAME)}"></a>
    <h1>${esc(title)}</h1>
    <p class="updated">Last updated: ${UPDATED}</p>
    ${body}
    <p class="nav"><a href="/">Back to ${esc(BRAND_NAME)}</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
  </main>
</body>
</html>`;
}

export function termsHtml(): string {
  return shell('Terms of Service', `
    <p>${esc(BRAND_NAME)} is a live chat. You can talk by camera, microphone, and text in rooms with other people. Using the site means you agree to these terms.</p>
    <h2>You must be 18 or older</h2>
    <p>You may create an account only if you are 18 or older. The register form asks you to confirm that. Do not use the service if you are under 18.</p>
    <h2>How to behave</h2>
    <p>You are responsible for what you say and show. No harassment, spam, illegal content, or sharing someone else's private information. That includes their contact details, their pictures, or a recording of them they did not agree to.</p>
    <h2>Moderators</h2>
    <p>Moderators and admins can remove messages, mute you, kick you from a room, and ban an account, an IP address, or a device. A ban can be temporary or permanent. Room owners can also kick and ban people from their own room. An admin may designate one chat bot as the moderator bot. That bot can kick and ban in any room, and it cannot act on an admin or on itself.</p>
    <h2>Your content</h2>
    <p>Chat, pictures, soundboard clips, and live video are user-generated. You keep whatever rights you already have in what you post. You let the service display it to the people in the room so the product can work. We do not review every message before it appears.</p>
    <h2>The service is provided as is</h2>
    <p>${esc(BRAND_NAME)} is provided as is. Calls can fail, rooms can go offline, and features can change. We do not promise that the service will be available, error-free, or fit for a particular purpose.</p>
    <h2>Accounts</h2>
    <p>We can refuse a registration, close an account, or end access when these terms are broken or when we need to protect the service. You can stop using ${esc(BRAND_NAME)} at any time.</p>
    <h2>Changes</h2>
    <p>These terms may change. The date at the top of this page is the latest version. Continuing to use the service after a change means you accept the new terms.</p>
    ${contactBlock()}
  `);
}

export function privacyHtml(): string {
  return shell('Privacy Policy', `
    <p>This page describes what ${esc(BRAND_NAME)} actually stores and why. It is a live chat with camera, microphone, and text. We do not sell personal information.</p>
    <h2>Account</h2>
    <ul>
      <li>Username, the time you joined, and the time you last signed in. This is how rooms know who you are.</li>
      <li>Email address, a lowercase copy used to detect duplicates, and whether you have confirmed it. Password reset and the confirm-email screen need it. Other people in a room do not see it. Moderators can see and edit it. We do not sell it.</li>
      <li>Password hash, if you chose a password. We store a bcrypt hash, not the password.</li>
      <li>If you use Google, Discord, or TikTok, we store that provider's account id (Google subject, Discord id, or TikTok open id) so the same person can sign in again. We do not store the provider access token. TikTok does not give us an email.</li>
      <li>Optional chat color, name effect, and a profile picture (a WebP file).</li>
    </ul>
    <h2>Safety and moderation</h2>
    <ul>
      <li>The IP address of your last sign-in, and the IP and browser string on each session. Used to investigate abuse and to enforce an IP ban.</li>
      <li>A random device id in the <code>camchat_did</code> cookie. Chat rows, reports, mutes, and bans can store it so a device ban still applies if the account changes.</li>
      <li>Room chat: the message text, time, username, role, IP, and device id. Threads, edits, reactions, and pins are stored with the message. A room keeps the newest 100 messages. Older ones are deleted.</li>
      <li>Pictures posted in chat, and soundboard clips a room owner uploaded. These are files on the server.</li>
      <li>Reports: who reported, who was reported, the reason, a copy of the message, a short bit of surrounding chat, and the IP and device when we have them.</li>
      <li>A moderation log of kicks, bans, mutes, and similar actions, including actions taken by the one moderator bot an admin has designated. It is kept for one year. The log does not include your email address. That bot can read room chat, including who sent it, so it can moderate.</li>
      <li>Bans of an account, IP, or device, including the reason and when they expire. Room mutes and room bans work the same way for one room.</li>
    </ul>
    <h2>Other things we keep</h2>
    <ul>
      <li>Friend requests between accounts.</li>
      <li>Room name, topic, lock, slow mode, and a hash of the room password if the room has one. The password itself is not stored.</li>
      <li>A hash of a bot token and a hash of an OBS stream key. The plaintext token and key are not stored.</li>
      <li>Password-reset and email-confirmation tokens are stored only as hashes. They expire after 60 minutes.</li>
      <li>Private messages are delivered live to the person who is online. They are not written to the database.</li>
    </ul>
    <h2>Camera, microphone, and live streams</h2>
    <p>Camera, microphone, and screen share go from your browser to the other people in the room. The media travels directly between browsers when the network allows it, and through our TURN relay when a direct path does not work. We do not record calls, and we do not store the audio or video.</p>
    <p>A room can also take a live RTMP broadcast, for example from OBS. The server transcodes that broadcast and publishes it into the room with WHIP so people there can watch it live. That is a relay of the live stream, not a saved recording. The RTMP server holds a short piece of the current video in memory so a viewer can join mid-stream. That memory is dropped when the broadcast stops.</p>
    <h2>Cookies</h2>
    <ul>
      <li><code>camchat_sid</code> keeps you signed in. It is HttpOnly. It lasts 30 days unless the session length is configured differently. The database stores a hash of the cookie, not the cookie itself.</li>
      <li><code>camchat_did</code> is the device id above. It is HttpOnly and lasts about two years. A copy is also kept in local storage on that browser so the page can send it.</li>
      <li>During Google, Discord, or TikTok sign-in we set short-lived cookies, about 10 minutes, for the sign-in state. TikTok also gets a cookie for the PKCE verifier. They are cleared when sign-in finishes.</li>
      <li>The browser's local storage also remembers layout choices on that device, such as volume, dock positions, and videos you hid. Those stay on the device.</li>
    </ul>
    <h2>Other services</h2>
    <p>Cloudflare hosts and fronts the site, so it sees connection data such as IP addresses. When email sending is turned on, confirmation and password-reset mail goes through Resend, or through an SMTP server if that is configured instead. That sender sees the address and the message. Google, Discord, and TikTok are involved only if you choose to sign in with them. They receive the sign-in, and we receive the account id they return. Google may also return an email address. We do not send your chat to them.</p>
    <p>If GIF search is configured, the words you search for are sent to Tenor or Giphy. By default, a call also asks Google's public STUN servers for a network path, which reveals your public IP to those servers for that lookup. Our TURN relay, when it is configured, is our own server. The signup check is a math question on our server unless Turnstile or hCaptcha is configured.</p>
    <h2>How long we keep it</h2>
    <p>Room chat is trimmed to the newest 100 messages. Sessions are removed after they expire. Mutes, expired room bans, and used or expired reset links are removed about a day after they end. Permanent bans stay until a moderator lifts them. The moderation log is deleted after one year. Profile pictures stay until you delete them. Chat pictures and soundboard clips stay until someone deletes them. There is no separate expiry job for those files.</p>
    <h2>Deletion</h2>
    <p>There is no delete button in the app. Ask a moderator in the app${CONTACT_EMAIL ? `, or email ${esc(CONTACT_EMAIL)},` : ''} to delete your account. Removing an account deletes the login, sessions, friend list, and email-confirmation tokens. Messages you already sent, reports, and bans can remain so moderators still have a record. Chat lines drop off as the room passes 100 messages, or when someone deletes them.</p>
    ${contactBlock()}
  `);
}
