# TikTok Login Kit

Sign in with TikTok uses Login Kit for Web (OAuth 2.0). The button appears only when both variables below are set. TikTok does not return an email, so a new account stops on the same “Confirm your email” screen Discord accounts use.

```bash
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

Redirect URI, exactly, with no query and no hash:

`https://chat.nano11bravo.com/auth/tiktok/callback`

On the server, `sudo bash deploy/tiktok-env.sh` backs up `/etc/camchat.env`, prompts for the key, prompts for the secret without echoing it, replaces only the `TIKTOK_*` lines, restarts `camchat`, and checks that `/api/health` reports `"tiktok":true`. That boolean is the only TikTok field in the health JSON. The script restores the backup and restarts again if the check fails.

Docs below were checked against TikTok for Developers on 4 August 2026.

## Create the app

1. Open [developers.tiktok.com](https://developers.tiktok.com), sign in, and create or join an organization if you want the app owned by a group.
2. Profile icon → **Manage apps** → **Connect an app**.
3. In **Products**, click **Add products** and add **Login Kit**. Choose the **Web** platform.
4. Set the Web redirect URI to `https://chat.nano11bravo.com/auth/tiktok/callback`. TikTok allows up to 10 redirect URIs. Each one must be `https`, shorter than 512 characters, static, and without a query string or `#`.
5. The scope this site requests is `user.info.basic` (`open_id`, `union_id`, `display_name`, `avatar_url`). Add that scope if it is not already on the app.

Web Login Kit does not require PKCE. State plus the client secret is the documented web flow. This server still sends `state`, a `code_challenge` of hex(SHA256(code_verifier)) with `code_challenge_method=S256` (the desktop method), and `code_verifier` on the token request.

## Verify the URL prefix

Apps created after 9 September 2024 must verify these URLs before review:

- Terms of Service URL
- Privacy Policy URL
- Web or Desktop URL

Sandbox URL verification is only required for Content Posting API, not for Login Kit.

On the app page, click **URL properties**, stay in **Production**, then **Verify properties**.

- **Domain:** enter the domain (for this site, `chat.nano11bravo.com` or the parent domain TikTok asks for) and confirm the DNS record they show.
- **URL prefix:** enter the full URL, click **Verify**, download TikTok’s signature file, and upload that file so it is served at the URL they name. Do that for the terms URL, the privacy URL, and the site URL you listed as the Web URL.

## Terms and privacy

The terms and privacy pages are public and do not require a login:

- https://chat.nano11bravo.com/terms
- https://chat.nano11bravo.com/privacy

TikTok’s review form asks for both URLs, and apps created after 9 September 2024 have to verify them with URL properties before you submit. `CONTACT_EMAIL` is optional. When it is set, both pages show it. When it is unset, they say to contact a moderator in the app.

Review also wants an app icon (1024×1024 JPEG or PNG, up to 5 MB), an app name, a category, and a description. The description is shown on the authorization page.

## Client key and secret

On the app page, open **App details → Credentials**. That section shows the **Client key** and **Client secret**. Those are `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.

## Sandbox before approval

You can try Login Kit before production review.

1. On the app page, switch the toggle next to the app name to **Sandbox**.
2. **Create Sandbox** (up to 5 sandboxes). Add Login Kit and the same redirect URI, then **Apply changes**.
3. **Sandbox settings → Target users → Add account**. Log in with a TikTok account you own (up to 10). The list can take up to an hour to show.
4. Those target users can complete the Login Kit authorization. Everyone else cannot, until the production app is approved.

Point the server at the sandbox client key and secret if the sandbox has its own credentials.

## Submit for review

Production mode starts in **Draft**. Under **App review**, explain how Login Kit and `user.info.basic` are used, upload a demo video of the sign-in flow (up to 5 videos, 50 MB each), **Save**, then **Submit for review**.

Status is in the left nav under **Production**: Draft, In review, Live, or Not approved. After it is Live, further changes go out only when a new revision is approved. Sandbox target users are the way to sign in before that.
