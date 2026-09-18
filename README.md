# MicCal: Blurred Spaces Scheduling

Your own branded booking page, similar to Calendly, hosted on **Netlify**. Guests pick a time, the app checks **every connected Google calendar** for conflicts, and the booking goes on your calendar with a **Zoom** link. The guest also gets an invite.

```
public/                 booking page (index.html), admin page, logo, background
netlify/functions/api.mjs   API: availability, booking, Google sign-in, admin
lib/core.mjs            time-zone + availability math (pure JS, unit-testable)
miccal.config.json      your hours, meeting types, branding
netlify.toml            routing + Node version
```

Your Google connections are stored in **Netlify Blobs**, Netlify's built-in storage. There's no database or disk to set up.

## 1. Deploy to Netlify

1. On app.netlify.com, go to **Add new project → Import an existing project → GitHub** and pick `blurredspaces/cal`.
2. Build settings are read from `netlify.toml`, so leave everything as it is and click **Deploy**.
3. Under **Project configuration → Environment variables**, add:

   | Key | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a strong password for `/admin` |
   | `GOOGLE_CLIENT_ID` | from step 2 |
   | `GOOGLE_CLIENT_SECRET` | from step 2 |
   | `BASE_URL` | `https://book.blurredspaces.com`. If you leave this out, it uses Netlify's site URL. |

   After adding or changing variables, redeploy with **Deploys → Trigger deploy**.

4. **Custom domain:** go to **Domain management → Add a domain** and enter `book.blurredspaces.com`. Then, wherever your DNS is managed, add:
   ```
   CNAME   book   →   <your-site-name>.netlify.app
   ```
   Your WordPress site at `blurredspaces.com` is not affected. Netlify issues HTTPS automatically.

## 2. Connect Google (one-time)

1. Go to https://console.cloud.google.com and create a project, then **enable Google Calendar API**.
2. **OAuth consent screen**
   - Choose User type **External**, name the app "Blurred Spaces", and add your logo.
   - Add the scopes `calendar.readonly` and `calendar.events`.
   - Add both of your Google emails as test users.
   - Then click **Publish app**. While it's in "Testing", Google disconnects you every 7 days. Once published, you'll see an "unverified app" screen; click *Advanced → Go to…*. Only you ever see this, because guests never sign in to Google.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Add these **Authorized redirect URIs**:
   ```
   https://book.blurredspaces.com/oauth/callback
   https://<your-site-name>.netlify.app/oauth/callback
   ```
4. Copy the client ID and secret into the Netlify environment variables, then redeploy.
5. Open `https://book.blurredspaces.com/admin`, sign in, and click **Connect Google account**. Do this once for **each** Google account.
   - Check which calendars to include in the conflict check.
   - Pick the **Book to** account. It sends the guest invite and creates the Meet link.

Until an account is connected, the booking page runs in **demo mode**: sample times, and no real events are created.

## 3. Connect Zoom (video links)

Meeting types with `"location": "zoom"` get a Zoom meeting created on your account at booking time. Until the Zoom keys below are set, they fall back to Google Meet.

1. Go to https://marketplace.zoom.us → **Develop → Build App → Server-to-Server OAuth App**, and name it "Blurred Spaces Scheduling".
2. **Information:** fill in the company name and developer contact (`tech@blurredspaces.com`).
3. **Scopes → Add scopes:** add `meeting:write:meeting:admin`. You can also add `meeting:delete:meeting:admin`, which lets the app clean up a Zoom meeting if a booking fails.
4. **Activation → Activate your app.**
5. From **App Credentials**, copy these values into Netlify's environment variables, marking the secret as secret, then redeploy:

   | Key | Value |
   |---|---|
   | `ZOOM_ACCOUNT_ID` | Account ID |
   | `ZOOM_CLIENT_ID` | Client ID |
   | `ZOOM_CLIENT_SECRET` | Client Secret |
   | `ZOOM_USER_EMAIL` | *(optional)* which Zoom user hosts the meetings. The default is the account owner. |

`/admin` shows "Zoom connected" once it's working. To go back to Meet for any meeting type, set its `location` to `"google_meet"`.

## Settings (`miccal.config.json`)

Edit the file, commit, and push. Netlify redeploys automatically.

| key | meaning |
|---|---|
| `timezone` | Your time zone. Working hours are interpreted in this zone. Guests see times in their own zone. |
| `working_hours` | Open windows for each weekday, e.g. `"mon": [["09:00","12:00"],["13:00","17:00"]]` |
| `slot_interval` | Minutes between start times |
| `buffer_minutes` | Minimum gap kept free around existing meetings |
| `min_notice_hours` / `max_days_ahead` | How soon, and how far ahead, guests can book |
| `mirror_to_other_calendars` | Also put a copy of the event on your other connected account(s) |
| `event_types` | Your meeting types. Each `slug` becomes a link, e.g. `/intro`. `location`: `"zoom"`, `"google_meet"`, or plain text such as a phone number or address. |

## Local development (optional)

This requires Node 22 or newer:
```bash
npm install
npx netlify-cli dev      # http://localhost:8888, with .env for variables
```
For local Google testing, also add `http://localhost:8888/oauth/callback` as a redirect URI.

## Security notes

- Google refresh tokens are stored in Netlify Blobs (store `miccal`) and are never sent to the browser.
- Admin sessions use an HMAC-signed, HttpOnly cookie, so set a strong `ADMIN_PASSWORD`.
- Every booking re-checks live availability before creating the event. Rate limiting is per function instance and best-effort.
