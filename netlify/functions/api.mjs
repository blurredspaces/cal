// MicCal — Blurred Spaces scheduling, as a single Netlify Function.
//
// Routes (wired up by rewrites in netlify.toml):
//   GET  /api/config                 public branding + event types
//   GET  /api/slots?event&start&end  open times across all connected calendars
//   POST /api/book                   create the Google Calendar event
//   GET  /admin/connect              start Google OAuth (admin only)
//   GET  /oauth/callback             finish Google OAuth, store refresh token in Netlify Blobs
//   /api/admin/*                     login / logout / manage connected accounts
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import cfg from "../../miccal.config.json";
import { computeSlots, demoBusy, iso, wallToUtc } from "../../lib/core.mjs";

// Trim: pasted values often carry stray spaces/newlines, which Google rejects as invalid_client.
const env = k => (process.env[k] || "").trim().replace(/^["']|["']$/g, "");
const BASE_URL = () => (env("BASE_URL") || env("URL") || "http://localhost:8888").replace(/\/$/, "");
const REDIRECT_URI = () => BASE_URL() + "/oauth/callback";
const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------- storage (Netlify Blobs)
const store = () => getStore("miccal", { consistency: "strong" });
const readAccounts = async () => (await store().get("accounts", { type: "json" })) || [];
const writeAccounts = accounts => store().setJSON("accounts", accounts);
const bookingAccount = accounts => accounts.find(a => a.book_to) || accounts[0];

let secretCache;
async function secret() {
  if (env("SECRET_KEY")) return env("SECRET_KEY");
  if (secretCache) return secretCache;
  let s = await store().get("secret");
  if (!s) { s = crypto.randomBytes(32).toString("hex"); await store().set("secret", s); }
  return (secretCache = s);
}

// ---------------------------------------------------------------- google
const tokenCache = new Map(); // email -> {token, exp}  (survives while the function is warm)
const busyCache = new Map();  // "from|to" -> {at, busy}

async function httpJson(url, { method = "GET", body, headers = {}, form = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    init.headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
  }
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`Google API ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function accessToken(acct) {
  const hit = tokenCache.get(acct.email);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const tok = await httpJson("https://oauth2.googleapis.com/token", {
    method: "POST", form: true, body: {
      client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: acct.refresh_token, grant_type: "refresh_token",
    },
  });
  tokenCache.set(acct.email, { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  return tok.access_token;
}

async function gcal(acct, path, method = "GET", body) {
  return httpJson("https://www.googleapis.com/calendar/v3" + path, {
    method, body, headers: { Authorization: "Bearer " + (await accessToken(acct)) },
  });
}

// Busy time across every selected calendar of every account. Fails closed on any error.
async function fetchBusy(accounts, from, to) {
  const results = await Promise.all(accounts.map(acct => gcal(acct, "/freeBusy", "POST", {
    timeMin: iso(from), timeMax: iso(to),
    items: (acct.calendars?.length ? acct.calendars : ["primary"]).map(id => ({ id })),
  }).then(res => [acct, res])));
  const busy = [];
  for (const [acct, res] of results) {
    for (const [calId, info] of Object.entries(res.calendars || {})) {
      if (info.errors) throw new Error(`Calendar ${calId} (${acct.email}): ${JSON.stringify(info.errors)}`);
      for (const b of info.busy || []) busy.push([Date.parse(b.start), Date.parse(b.end)]);
    }
  }
  return busy;
}

function busyGetter(accounts, useCache = true) {
  return async (from, to) => {
    if (!accounts.length) return demoBusy(cfg.timezone, from, to);
    const key = `${from}|${to}`, hit = busyCache.get(key);
    if (useCache && hit && Date.now() - hit.at < 60_000) return hit.busy;
    const busy = await fetchBusy(accounts, from, to);
    busyCache.set(key, { at: Date.now(), busy });
    return busy;
  };
}

// ---------------------------------------------------------------- zoom (Server-to-Server OAuth)
let zoomToken = null; // {token, exp}
const zoomConfigured = () => !!(env("ZOOM_ACCOUNT_ID") && env("ZOOM_CLIENT_ID") && env("ZOOM_CLIENT_SECRET"));
// Until Zoom credentials are added, "zoom" events fall back to Google Meet so bookings keep working.
const locationOf = e => (e.location === "zoom" && !zoomConfigured() ? "google_meet" : e.location);

async function zoomApi(path, method = "GET", body) {
  if (!zoomToken || zoomToken.exp < Date.now() + 60_000) {
    const basic = Buffer.from(`${env("ZOOM_CLIENT_ID")}:${env("ZOOM_CLIENT_SECRET")}`).toString("base64");
    const r = await fetch("https://zoom.us/oauth/token?" + new URLSearchParams({
      grant_type: "account_credentials", account_id: env("ZOOM_ACCOUNT_ID") }), {
      method: "POST", headers: { Authorization: "Basic " + basic },
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Zoom auth ${r.status}: ${JSON.stringify(tok).slice(0, 300)}`);
    zoomToken = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
  }
  const r = await fetch("https://api.zoom.us/v2" + path, {
    method, headers: { Authorization: "Bearer " + zoomToken.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Zoom API ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Creates a scheduled meeting on the Zoom account owner (or ZOOM_USER_EMAIL if set).
async function createZoomMeeting({ topic, start, duration, agenda }) {
  if (!zoomConfigured()) throw new Error("Zoom isn't configured: set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.");
  const user = encodeURIComponent(env("ZOOM_USER_EMAIL") || "me");
  const m = await zoomApi(`/users/${user}/meetings`, "POST", {
    topic: topic.slice(0, 200), type: 2, start_time: iso(start), duration, timezone: cfg.timezone,
    agenda: agenda.slice(0, 2000),
    settings: { join_before_host: false, waiting_room: true, mute_upon_entry: true, approval_type: 2 },
  });
  return { id: m.id, join_url: m.join_url, password: m.password || "" };
}

// ---------------------------------------------------------------- http helpers
const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const text = (status, body) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { Location: location, ...headers } });

function getCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
  (BASE_URL().startsWith("https") ? "; Secure" : "");

const hmac = async value => crypto.createHmac("sha256", await secret()).update(value).digest("hex");
const sign = async value => `${value}.${await hmac(value)}`;
async function unsign(signed) {
  if (!signed || !signed.includes(".")) return null;
  const i = signed.lastIndexOf("."), value = signed.slice(0, i), mac = Buffer.from(signed.slice(i + 1));
  const good = Buffer.from(await hmac(value));
  return mac.length === good.length && crypto.timingSafeEqual(mac, good) ? value : null;
}
const isAdmin = async req => (await unsign(getCookie(req, "mc_admin"))) === "admin";
const safeEqual = (a, b) => {
  const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

// Best-effort per-IP limit (per warm function instance).
const hits = new Map();
function rateLimited(ip, limit = 8, windowMs = 3_600_000) {
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
  hits.set(ip, [...recent, now]);
  return recent.length >= limit;
}

// ---------------------------------------------------------------- public routes
function apiConfig(accounts) {
  return json(200, {
    brand: cfg.brand, timezone: cfg.timezone, max_days_ahead: cfg.max_days_ahead ?? 60,
    event_types: cfg.event_types.map(e => ({ ...e, location: locationOf(e) })), demo: accounts.length === 0,
  });
}

async function apiSlots(url, accounts) {
  const event = cfg.event_types.find(e => e.slug === url.searchParams.get("event"));
  if (!event) return json(404, { error: "Unknown event type" });
  const start = Date.parse(url.searchParams.get("start")), end = Date.parse(url.searchParams.get("end"));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return json(400, { error: "start and end must be ISO timestamps" });
  if (end - start > 45 * 86_400_000) return json(400, { error: "Range too large" });
  const slots = await computeSlots(cfg, event, start, end, busyGetter(accounts));
  return json(200, { slots: slots.map(iso) });
}

async function apiBook(req, body, accounts, ip) {
  const event = cfg.event_types.find(e => e.slug === String(body.event || ""));
  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);
  const notes = String(body.notes || "").trim().slice(0, 2000);
  const guestTz = String(body.timezone || "").slice(0, 64);
  const phone = String(body.phone || "").trim().slice(0, 30);
  const start = Date.parse(String(body.start || ""));
  if (!event) return json(400, { error: "Unknown event type" });
  if (!name || !EMAIL_RE.test(email)) return json(400, { error: "Please enter your name and a valid email." });
  if (!Number.isFinite(start)) return json(400, { error: "Invalid start time" });
  // Mobile number: required for phone calls, optional (but validated if given) for everything else.
  const phoneOk = phone.replace(/\D/g, "").length >= 7 && /^[+\d\s().-]+$/.test(phone);
  if ((event.location === "phone" || phone) && !phoneOk) {
    return json(400, { error: "Please enter a valid mobile number." });
  }
  if (rateLimited(ip)) return json(429, { error: "Too many booking attempts. Try again later." });

  // Re-check live availability (no cache) right before creating the event.
  const end = start + event.duration * 60_000;
  const fresh = await computeSlots(cfg, event, start, end, busyGetter(accounts, false));
  if (!fresh.includes(start)) return json(409, { error: "That time was just taken. Please pick another." });

  const host = cfg.brand.host_name;
  const summary = `${event.title}: ${name} × ${host}`;
  const description = [
    `Booked via ${cfg.brand.company} scheduling.`,
    `Guest: ${name} <${email}>`,
    phone && `Mobile: ${phone}`,
    guestTz && `Guest time zone: ${guestTz}`,
    notes && `\nNotes from guest:\n${notes}`,
  ].filter(Boolean).join("\n");
  const base = { start: iso(start), event: event.title, duration: event.duration, summary };
  if (!accounts.length) return json(200, { ...base, demo: true, join_link: null });

  // Create the video meeting first so its link goes into the calendar invite.
  let zoom = null;
  const location = locationOf(event);
  if (location === "zoom") {
    zoom = await createZoomMeeting({ topic: summary, start, duration: event.duration, agenda: description });
  }
  const joinInfo = zoom
    ? [`Join Zoom meeting: ${zoom.join_url}`, `Meeting ID: ${String(zoom.id).replace(/(\d{3})(\d{4})(\d+)/, "$1 $2 $3")}`,
       zoom.password && `Passcode: ${zoom.password}`].filter(Boolean).join("\n") + "\n\n"
    : "";

  const primary = bookingAccount(accounts);
  const ev = {
    summary, description: joinInfo + description,
    start: { dateTime: iso(start), timeZone: cfg.timezone },
    end: { dateTime: iso(end), timeZone: cfg.timezone },
    attendees: [{ email, displayName: name }],
    reminders: { useDefault: true },
  };
  if (zoom) ev.location = zoom.join_url;
  else if (location === "google_meet") {
    ev.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  } else if (location === "phone") ev.location = phone;
  else if (location) ev.location = location;

  let created;
  try {
    created = await gcal(primary, "/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1", "POST", ev);
  } catch (e) {
    // Don't leave an orphaned Zoom meeting if the calendar event couldn't be created.
    if (zoom) await zoomApi(`/meetings/${zoom.id}`, "DELETE").catch(() => {});
    throw e;
  }
  const joinLink = zoom?.join_url || created.hangoutLink || null;

  // Optional hold on the other connected calendars so they show the time too.
  if (cfg.mirror_to_other_calendars) {
    await Promise.all(accounts.filter(a => a.email !== primary.email).map(a =>
      gcal(a, "/calendars/primary/events", "POST", {
        summary, start: ev.start, end: ev.end, location: ev.location,
        description: (joinInfo || (joinLink ? `Join: ${joinLink}\n\n` : "")) + description + `\n\n(Hold: invite lives on ${primary.email})`,
      }).catch(e => console.error("mirror failed", a.email, e.message))));
  }
  busyCache.clear();
  return json(200, { ...base, demo: false, join_link: joinLink });
}

// ---------------------------------------------------------------- agenda (/today)
// Events from every selected calendar for today + tomorrow, in the owner's time zone.
async function apiToday(accounts) {
  const tz = cfg.timezone;
  const dayKey = t => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const today = dayKey(Date.now());
  const tomorrow = dayKey(Date.now() + 86_400_000);
  // Window: start of today through end of tomorrow, in the owner's zone.
  const [y, m, d] = today.split("-").map(Number);
  const startMs = wallToUtc(tz, y, m, d, 0, 0);
  const endMs = startMs + 2 * 86_400_000 + 3_600_000; // + an hour of slack for DST

  const events = [];
  await Promise.all(accounts.flatMap(acct =>
    (acct.calendars?.length ? acct.calendars : ["primary"]).map(async calId => {
      const q = new URLSearchParams({
        timeMin: iso(startMs), timeMax: iso(endMs), singleEvents: "true",
        orderBy: "startTime", maxResults: "50",
      });
      const res = await gcal(acct, `/calendars/${encodeURIComponent(calId)}/events?${q}`);
      for (const e of res.items || []) {
        if (e.status === "cancelled") continue;
        const allDay = !!e.start?.date;
        const startT = allDay ? wallToUtc(tz, ...e.start.date.split("-").map(Number), 0, 0) : Date.parse(e.start.dateTime);
        const endT = allDay ? wallToUtc(tz, ...e.end.date.split("-").map(Number), 0, 0) : Date.parse(e.end.dateTime);
        const day = allDay ? e.start.date : dayKey(startT);
        // All-day events can span days; include them on today/tomorrow if they overlap.
        const days = allDay
          ? [today, tomorrow].filter(k => k >= day && wallToUtc(tz, ...k.split("-").map(Number), 0, 0) < endT)
          : [day];
        for (const dk of days) {
          if (dk !== today && dk !== tomorrow) continue;
          events.push({
            day: dk, allDay, start: allDay ? null : iso(startT), end: allDay ? null : iso(endT),
            summary: e.summary || "(no title)", location: e.location || null,
            description: (e.description || "").slice(0, 400) || null,
            conference: e.hangoutLink || null,
            attendees: (e.attendees || []).filter(a => !a.self).map(a => a.displayName || a.email).slice(0, 12),
            organizer: e.organizer?.email || null,
            calendar: res.summary || calId, account: acct.email,
            link: e.htmlLink || null, status: e.status || null,
          });
        }
      }
    })));

  events.sort((a, b) => (a.day.localeCompare(b.day)) || (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1));
  return json(200, {
    timezone: tz, generated: iso(Date.now()), brand: cfg.brand,
    days: [{ key: today, label: "Today" }, { key: tomorrow, label: "Tomorrow" }],
    events,
  });
}

// ---------------------------------------------------------------- admin routes
async function apiLogin(body) {
  if (!env("ADMIN_PASSWORD")) return json(400, { error: "Set ADMIN_PASSWORD in Netlify environment variables first." });
  await new Promise(r => setTimeout(r, 400)); // slow brute force a little
  if (!safeEqual(String(body.password || ""), env("ADMIN_PASSWORD"))) return json(401, { error: "Wrong password" });
  return json(200, { ok: true }, { "Set-Cookie": setCookie("mc_admin", await sign("admin"), 60 * 60 * 12) });
}

async function apiAccounts(accounts) {
  const out = await Promise.all(accounts.map(async a => {
    const item = { email: a.email, calendars: a.calendars?.length ? a.calendars : ["primary"], book_to: !!a.book_to, available: [], error: null };
    try {
      const list = await gcal(a, "/users/me/calendarList?minAccessRole=freeBusyReader");
      item.available = (list.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary }));
    } catch (e) { item.error = e.message; }
    return item;
  }));
  return json(200, {
    accounts: out, base_url: BASE_URL(), redirect_uri: REDIRECT_URI(),
    google_configured: !!env("GOOGLE_CLIENT_ID"),
    zoom_configured: zoomConfigured(),
    zoom_needed: cfg.event_types.some(e => e.location === "zoom"),
    event_types: cfg.event_types.map(e => ({ slug: e.slug, title: e.title })),
  });
}

async function apiAccountUpdate(body, accounts) {
  const acct = accounts.find(a => a.email === body.email);
  if (acct) {
    if (Array.isArray(body.calendars)) acct.calendars = body.calendars.map(String).slice(0, 20);
    if (!acct.calendars?.length) acct.calendars = ["primary"];
    if (body.book_to) accounts.forEach(a => { a.book_to = a === acct; });
    await writeAccounts(accounts);
  }
  busyCache.clear();
  return json(200, { ok: true });
}

async function oauthStart() {
  if (!env("GOOGLE_CLIENT_ID")) return text(400, "Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Netlify environment variables.");
  const state = crypto.randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: REDIRECT_URI(), response_type: "code",
    scope: SCOPES, access_type: "offline", prompt: "consent select_account",
    include_granted_scopes: "true", state,
  });
  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params,
    { "Set-Cookie": setCookie("mc_state", await sign(state), 600) });
}

async function oauthCallback(req, url) {
  const q = Object.fromEntries(url.searchParams);
  if (q.error) return redirect("/admin?error=" + encodeURIComponent(q.error));
  if (!q.state || (await unsign(getCookie(req, "mc_state"))) !== q.state) return text(400, "OAuth state mismatch — try connecting again.");
  const tok = await httpJson("https://oauth2.googleapis.com/token", {
    method: "POST", form: true, body: {
      code: q.code || "", client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: REDIRECT_URI(), grant_type: "authorization_code",
    },
  });
  const { email } = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
  if (!tok.refresh_token) {
    return redirect("/admin?error=" + encodeURIComponent(
      "Google didn't return a refresh token. Remove the app at myaccount.google.com/permissions and reconnect."));
  }
  const accounts = (await readAccounts()).filter(a => a.email !== email);
  accounts.push({ email, refresh_token: tok.refresh_token, calendars: ["primary"], book_to: accounts.length === 0 });
  await writeAccounts(accounts);
  tokenCache.set(email, { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  busyCache.clear();
  return redirect("/admin?connected=" + encodeURIComponent(email), { "Set-Cookie": setCookie("mc_state", "", 0) });
}

// ---------------------------------------------------------------- router
export default async (req, context) => {
  const url = new URL(req.url);
  // Works whether Netlify hands us the original path or the rewritten /.netlify/functions/api/... one.
  const path = url.pathname.replace(/^\/\.netlify\/functions\/api/, "") || "/";
  const admin = await isAdmin(req);
  try {
    const accounts = await readAccounts();
    if (req.method === "GET") {
      if (path === "/api/config") return apiConfig(accounts);
      if (path === "/api/slots") return await apiSlots(url, accounts);
      if (path === "/api/today") return admin ? await apiToday(accounts) : json(401, { error: "Login required" });
      if (path === "/api/admin/accounts") return admin ? await apiAccounts(accounts) : json(401, { error: "Login required" });
      if (path === "/admin/connect") return admin ? await oauthStart() : redirect("/admin");
      if (path === "/oauth/callback") return admin ? await oauthCallback(req, url) : redirect("/admin");
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (path === "/api/book") return await apiBook(req, body, accounts, context.ip || "unknown");
      if (path === "/api/admin/login") return await apiLogin(body);
      if (path === "/api/admin/logout") return json(200, { ok: true }, { "Set-Cookie": setCookie("mc_admin", "", 0) });
      if (!admin) return json(401, { error: "Login required" });
      if (path === "/api/admin/accounts/update") return await apiAccountUpdate(body, accounts);
      if (path === "/api/admin/accounts/remove") {
        await writeAccounts(accounts.filter(a => a.email !== body.email));
        busyCache.clear();
        return json(200, { ok: true });
      }
    }
    return json(404, { error: "Not found" });
  } catch (e) {
    console.error("ERROR", path, e);
    return json(500, { error: admin ? e.message : "Something went wrong. Please try again." });
  }
};
