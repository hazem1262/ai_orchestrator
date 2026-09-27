# Setup — Linear, Slack and remote access

How to connect Orchestrator to Linear and Slack (both act as you) and how to reach it from your phone through `tailscale serve`. The sections below are the Phase 6 plan's operator setup, copied as written.

> **Notes on this build (Phase 6 exit, 2026-09-27):**
> - Linear OAuth (plan Task 21) was **not built**. Use the personal API key in section A. `GET /api/connectors/linear/authorize` answers `404 not_found` ("paste a token instead").
> - Spike S9's live checks (`plan/spikes/S9.md`, a–h) have not been run yet. Until they pass, remote access follows the plan's defaults, which are not confirmed on a real phone or tailnet.

## Operator setup

### A. Linear: personal API key (the default path)
1. In Linear, open **Settings → Security & access → Personal API keys → New API key**.
2. Name the key `orchestrator`. Give it Read + Write access (or "Full access") for the teams you work in.
3. Copy the `lin_api_…` key. In Orchestrator, open **Settings → Connectors → Linear**, paste the key and click **Connect**. The key goes into the Keychain as `orchestrator / linear.token`.

The optional OAuth path is Task 21.

### B. Slack app (one-time; the app acts as you through a user token)
1. Go to <https://api.slack.com/apps>, choose **Create New App → From an app manifest**, and pick your workspace.
2. Paste this manifest. Replace `<machine>.<tailnet>` with your MagicDNS name, or delete that line if you won't use OAuth over Tailscale.
   ```yaml
   display_information:
     name: Orchestrator (personal)
     description: Personal agent orchestrator. Posts and reads as me.
   oauth_config:
     redirect_urls:
       - http://127.0.0.1:4317/api/connectors/slack/callback
       - https://<machine>.<tailnet>.ts.net/api/connectors/slack/callback
     scopes:
       user:
         - chat:write
         - im:write
         - im:history
         - channels:history
         - groups:history
         - search:read
         - users:read
         - reminders:write
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```
   `reminders:write` is only used if spike S9 shows that DMs to yourself don't trigger phone notifications (`connectors.slack.nudgeViaReminder`).
3. **Redirect URL caveat.** Slack's docs say *"The `redirect_uri` must use HTTPS."* If Slack rejects the `http://127.0.0.1` URL (spike S9 check g), delete it. Then either use the `https://…ts.net` URL (set `connectors.slack.redirectUri` to it) or use the token-paste path in step 5.
4. **OAuth path:** open **Basic Information** and copy the *Client ID* and *Client Secret*. Paste both into **Settings → Connectors → Slack → OAuth app**, then click **Connect with Slack**. The daemon exchanges the code with `oauth.v2.access` and stores `authed_user.access_token` (an `xoxp-` token) in the Keychain as `slack.token`.
5. **Paste path (no redirect needed):** open **OAuth & Permissions → Install to Workspace → Allow**, copy the **User OAuth Token** (`xoxp-…`), and paste it into **Settings → Connectors → Slack → Connect**.
6. Optional: for the daily update, copy the channel ID (right-click the channel → *View channel details* → the ID at the bottom, `C…`) into `connectors.slack.dailyChannel` in `$ORC_HOME/config.json`.

### C. Tailscale serve (remote access)
1. Install Tailscale on the Mac and the phone, and log both into the **same** tailnet user. That user's login email becomes `remote.allowedLogin`.
2. In the Tailscale admin console, open **DNS** and enable **MagicDNS** and **HTTPS Certificates** (a one-time step).
3. On the Mac:
   ```bash
   tailscale status                                   # note <machine>.<tailnet>.ts.net
   tailscale serve --bg http://127.0.0.1:4317         # HTTPS inside the tailnet only
   tailscale serve status                             # shows https://<machine>.<tailnet>.ts.net → http://127.0.0.1:4317
   ```
   To turn it off: `tailscale serve --https=443 off`, or `tailscale serve reset`. **Never run `tailscale funnel`.**
4. In `$ORC_HOME/config.json`:
   ```json
   { "remote": { "enabled": true, "origin": "https://<machine>.<tailnet>.ts.net", "allowedLogin": "<you>@<domain>" } }
   ```
5. **Pair the phone:**
   1. On the Mac, open **Settings → Remote → Create pairing code**.
   2. On the phone, open `https://<machine>.<tailnet>.ts.net/pair`, enter the code and a device name.
   3. Create the passkey when prompted, then allow notifications.
   4. On iOS 16.4+ you must first **Add to Home Screen** and open the installed app before push can be enabled.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Settings → Connectors shows `error` for Slack | The token was revoked or a scope is missing. Re-install the Slack app and paste the new User OAuth Token. |
| Slack rejects the redirect URL | Slack requires HTTPS. Use `https://<machine>.<tailnet>.ts.net/api/connectors/slack/callback`, or skip OAuth and paste the User OAuth Token. |
| The phone shows "remote access is disabled" | `remote.enabled`, `remote.origin` and `remote.allowedLogin` must all be set (Settings → Remote). |
| The phone shows "unexpected host" | The origin in Settings must match the MagicDNS name exactly, including `https://` and no trailing slash. |
| The phone shows "Tailscale Funnel is on" | Run `tailscale funnel --https=443 off`. The app refuses remote access while a Funnel exists. |
| Pairing says "wrong or expired pairing code" | Codes last 5 minutes, work once, and are cancelled after five wrong tries. Create a new one. |
| iOS shows no notifications | Add the app to the Home Screen and open it from there first (iOS 16.4+ only allows push for installed web apps). |
| Sending from the phone asks for the passkey every time | That is the step-up. It lasts 5 minutes (`remote.stepUpTtlSec`). |
| A Slack thread reply does nothing | The session must be **owned** (launched or resumed inside the app). The thread's first message says when replies are off. |
| Everything is broken after a Mac restart | `tailscale serve --bg http://127.0.0.1:4317` must run again if you did not use `--bg`, and the daemon must be running. |

## What the app never does
- It never exposes itself to the public internet (no `tailscale funnel`).
- It never sends the install token to a remote device; remote devices use their own revocable token.
- It never posts unredacted text to Slack or Linear.
- It never sends input to a session it does not own.
