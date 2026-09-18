# MicCal: Blurred Spaces Scheduling

Your own branded booking page, similar to Calendly. Guests pick a time, the app checks **every connected Google calendar** for conflicts, and the booking goes on your calendar with a Google Meet link. The guest also gets an invite.

- No dependencies to install. Needs only Python 3.9 or newer.
- Hours, durations, buffers, and branding are set in `config.json`.
- Connect Google accounts and copy share links at `/admin`.

## Run locally

```bash
cp .env.example .env      # then set ADMIN_PASSWORD
python3 server.py         # http://localhost:3000
```

Until a Google account is connected, the page runs in **demo mode**: sample availability, and no events are created.

## Connect Google (one-time, about 10 minutes)

1. Go to https://console.cloud.google.com and create a project, for example "Blurred Spaces Scheduling".
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen (Google Auth Platform)**
   - Choose User type **External**. If both calendars are in the same Google Workspace, use **Internal** instead.
   - Set the app name to "Blurred Spaces" and upload the logo.
   - Under Data access, add the scopes `.../auth/calendar.readonly` and `.../auth/calendar.events`.
   - Under Audience, add both of your Google emails as test users. Then click **Publish app**. While the app stays in "Testing" status, Google expires the connection every 7 days. Once published, Google shows you an "unverified app" warning; click *Advanced → Go to…*. Only you ever see this screen, because guests never sign in.
4. **Credentials → Create credentials → OAuth client ID → Web application**
   - Authorized redirect URI: `http://localhost:3000/oauth/callback`. For the live site, also add `https://YOUR-DOMAIN/oauth/callback`.
5. Put the client ID and secret into `.env`, then restart `python3 server.py`.
6. Open `/admin`, sign in, and click **Connect Google account**. Do this once for **each** Google account.
   - Check which calendars to include in the conflict check for each account.
   - Pick which account is **Book to**. That account sends the invite and holds the Meet link.
   - If `mirror_to_other_calendars` is `true` in `config.json`, the other account also gets a copy of the event, so both calendars show it.

## Settings (`config.json`)

| key | meaning |
|---|---|
| `timezone` | Your time zone. Working hours are interpreted in this zone. Guests see times in their own zone. |
| `working_hours` | Open windows for each weekday, e.g. `"mon": [["09:00","12:00"],["13:00","17:00"]]` |
| `slot_interval` | Minutes between start times |
| `buffer_minutes` | Minimum gap kept free around existing meetings |
| `min_notice_hours` / `max_days_ahead` | How soon, and how far ahead, guests can book |
| `event_types` | Your meeting types. Each `slug` becomes a link, e.g. `/intro` |

## Put it online (so you can send the link)

It needs a public HTTPS address. Two easy options:

- **Render.com**: create a new Web Service from this folder or repo. Start command: `python3 server.py`. Add a **persistent disk** mounted at `/var/data` and set `DATA_DIR=/var/data`, because that's where the Google connection is stored. Set the env vars from `.env`, with `BASE_URL=https://book.blurredspaces.com`.
- **Any small VPS** (DigitalOcean, Lightsail): run `python3 server.py` behind Caddy or nginx for HTTPS.

Then point a subdomain such as `book.blurredspaces.com` at the host, and add that domain's `/oauth/callback` to your Google OAuth client.

## Security notes

- `data/accounts.json` holds your Google refresh tokens. It is git-ignored and written with `600` permissions. Never share it.
- The admin area uses a signed cookie, so set a strong `ADMIN_PASSWORD`.
- Every booking re-checks live availability under a lock, so two guests can't take the same slot. Each IP address can make at most 8 booking attempts per hour.
