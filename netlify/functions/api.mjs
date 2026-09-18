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
import { computeSlots, demoBusy, iso } from "../../lib/core.mjs";

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
    event_types: cfg.event_types, demo: accounts.length === 0,
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
  const start = Date.parse(String(body.start || ""));
  if (!event) return json(400, { error: "Unknown event type" });
  if (!name || !EMAIL_RE.test(email)) return json(400, { error: "Please enter your name and a valid email." });
  if (!Number.isFinite(start)) return json(400, { error: "Invalid start time" });
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
    guestTz && `Guest time zone: ${guestTz}`,
    notes && `\nNotes from guest:\n${notes}`,
  ].filter(Boolean).join("\n");
  const base = { start: iso(start), event: event.title, duration: event.duration, summary };
  if (!accounts.length) return json(200, { ...base, demo: true, meet_link: null });

  const primary = bookingAccount(accounts);
  const ev = {
    summary, description,
    start: { dateTime: iso(start), timeZone: cfg.timezone },
    end: { dateTime: iso(end), timeZone: cfg.timezone },
    attendees: [{ email, displayName: name }],
    reminders: { useDefault: true },
  };
  if (event.location === "google_meet") {
    ev.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  } else if (event.location) ev.location = event.location;

  const created = await gcal(primary, "/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1", "POST", ev);
  const meet = created.hangoutLink || null;

  // Optional hold on the other connected calendars so they show the time too.
  if (cfg.mirror_to_other_calendars) {
    await Promise.all(accounts.filter(a => a.email !== primary.email).map(a =>
      gcal(a, "/calendars/primary/events", "POST", {
        summary, start: ev.start, end: ev.end,
        description: description + (meet ? `\n\nJoin: ${meet}` : "") + `\n\n(Hold: invite lives on ${primary.email})`,
      }).catch(e => console.error("mirror failed", a.email, e.message))));
  }
  busyCache.clear();
  return json(200, { ...base, demo: false, meet_link: meet });
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
