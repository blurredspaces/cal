#!/usr/bin/env python3
"""MicCal — branded scheduling for Blurred Spaces.

Zero-dependency (Python 3.9+ stdlib only) booking server:
  * Connect any number of Google accounts (OAuth, offline refresh tokens)
  * Availability = working hours minus busy time across every selected calendar
  * Booking creates a Google Calendar event (with Meet link + invite to the guest)

Run:  python3 server.py        (reads .env, serves on PORT, default 3000)
"""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.path.join(ROOT, "data")
ACCOUNTS_FILE = os.path.join(DATA, "accounts.json")
os.makedirs(DATA, exist_ok=True)


# ---------------------------------------------------------------- env / config
def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
PORT = int(os.environ.get("PORT", "3000"))
BASE_URL = os.environ.get("BASE_URL", f"http://localhost:{PORT}").rstrip("/")
CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
REDIRECT_URI = BASE_URL + "/oauth/callback"
SCOPES = " ".join([
    "openid", "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
])


def _secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"].encode()
    path = os.path.join(DATA, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip().encode()


SECRET = _secret_key()


def load_config():
    with open(os.path.join(ROOT, "config.json")) as f:
        return json.load(f)


# ---------------------------------------------------------------- account store
_store_lock = threading.Lock()


def read_accounts():
    if not os.path.exists(ACCOUNTS_FILE):
        return []
    with open(ACCOUNTS_FILE) as f:
        return json.load(f)


def write_accounts(accounts):
    tmp = ACCOUNTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(accounts, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ACCOUNTS_FILE)


def booking_account(accounts):
    for a in accounts:
        if a.get("book_to"):
            return a
    return accounts[0] if accounts else None


# ---------------------------------------------------------------- google api
_token_cache = {}  # email -> (access_token, expires_at)


def http_json(url, method="GET", body=None, headers=None, form=False):
    headers = dict(headers or {})
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Google API {e.code}: {detail}") from None


def access_token(account):
    cached = _token_cache.get(account["email"])
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    tok = http_json("https://oauth2.googleapis.com/token", "POST", {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": account["refresh_token"],
        "grant_type": "refresh_token",
    }, form=True)
    _token_cache[account["email"]] = (tok["access_token"], time.time() + tok.get("expires_in", 3600))
    return tok["access_token"]


def gcal(account, path, method="GET", body=None):
    return http_json("https://www.googleapis.com/calendar/v3" + path, method, body,
                     {"Authorization": "Bearer " + access_token(account)})


def parse_rfc3339(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_busy(accounts, start, end):
    """Busy intervals across every selected calendar of every account. Fails closed."""
    busy = []
    for acct in accounts:
        cals = acct.get("calendars") or ["primary"]
        res = gcal(acct, "/freeBusy", "POST", {
            "timeMin": iso_utc(start), "timeMax": iso_utc(end),
            "items": [{"id": c} for c in cals],
        })
        for cal_id, info in res.get("calendars", {}).items():
            if info.get("errors"):
                raise RuntimeError(f"Calendar {cal_id} ({acct['email']}): {info['errors']}")
            for b in info.get("busy", []):
                busy.append((parse_rfc3339(b["start"]), parse_rfc3339(b["end"])))
    return busy


def demo_busy(start, end, tz):
    """Deterministic fake meetings so the UI is testable before Google is connected."""
    busy, d = [], start.astimezone(tz).date()
    while d <= end.astimezone(tz).date():
        h = int(hashlib.md5(d.isoformat().encode()).hexdigest(), 16)
        for i in range(h % 3 + 1):
            hour = 9 + (h >> (i * 4)) % 8
            s = datetime.combine(d, dtime(hour, 0), tzinfo=tz)
            busy.append((s, s + timedelta(minutes=60 if (h >> i) & 1 else 30)))
        d += timedelta(days=1)
    return busy


_busy_cache = {}  # (start, end) -> (fetched_at, busy)


def get_busy(start, end, tz, use_cache=True):
    accounts = read_accounts()
    if not accounts:
        return demo_busy(start, end, tz)
    key = (start.isoformat(), end.isoformat())
    hit = _busy_cache.get(key)
    if use_cache and hit and time.time() - hit[0] < 60:
        return hit[1]
    busy = fetch_busy(accounts, start, end)
    _busy_cache[key] = (time.time(), busy)
    return busy


# ---------------------------------------------------------------- availability
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def find_event(cfg, slug):
    for e in cfg["event_types"]:
        if e["slug"] == slug:
            return e
    return None


def compute_slots(cfg, event, range_start, range_end, use_cache=True):
    tz = ZoneInfo(cfg["timezone"])
    dur = timedelta(minutes=event["duration"])
    step = timedelta(minutes=cfg.get("slot_interval", event["duration"]))
    buffer = timedelta(minutes=cfg.get("buffer_minutes", 0))
    now = datetime.now(timezone.utc)
    lo = max(range_start, now + timedelta(hours=cfg.get("min_notice_hours", 0)))
    hi = min(range_end, now + timedelta(days=cfg.get("max_days_ahead", 60)))
    if lo >= hi:
        return []

    busy = get_busy(lo - buffer, hi + dur + buffer, tz, use_cache)
    slots = []
    day = lo.astimezone(tz).date() - timedelta(days=1)
    last = hi.astimezone(tz).date()
    while day <= last:
        for ws, we in cfg["working_hours"].get(WEEKDAYS[day.weekday()], []):
            t = datetime.combine(day, dtime.fromisoformat(ws), tzinfo=tz)
            w_end = datetime.combine(day, dtime.fromisoformat(we), tzinfo=tz)
            while t + dur <= w_end:
                if t >= lo and t < hi:
                    t_end = t + dur
                    if not any(bs - buffer < t_end and be + buffer > t for bs, be in busy):
                        slots.append(t.astimezone(timezone.utc))
                t += step
        day += timedelta(days=1)
    return slots


# ---------------------------------------------------------------- booking
_book_lock = threading.Lock()
_rate = {}  # ip -> [timestamps]
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def rate_limited(ip, limit=8, window=3600):
    now = time.time()
    hits = [t for t in _rate.get(ip, []) if now - t < window]
    _rate[ip] = hits + [now]
    return len(hits) >= limit


def create_booking(cfg, event, start, name, email, notes, guest_tz):
    accounts = read_accounts()
    end = start + timedelta(minutes=event["duration"])
    host = cfg["brand"]["host_name"]
    summary = f"{event['title']}: {name} × {host}"
    description = "\n".join(filter(None, [
        f"Booked via {cfg['brand']['company']} scheduling.",
        f"Guest: {name} <{email}>",
        f"Guest time zone: {guest_tz}" if guest_tz else "",
        f"\nNotes from guest:\n{notes}" if notes else "",
    ]))
    if not accounts:  # demo mode
        return {"demo": True, "summary": summary, "meet_link": None}

    primary = booking_account(accounts)
    body = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": iso_utc(start), "timeZone": cfg["timezone"]},
        "end": {"dateTime": iso_utc(end), "timeZone": cfg["timezone"]},
        "attendees": [{"email": email, "displayName": name}],
        "reminders": {"useDefault": True},
    }
    if event.get("location") == "google_meet":
        body["conferenceData"] = {"createRequest": {
            "requestId": uuid.uuid4().hex,
            "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
    elif event.get("location"):
        body["location"] = event["location"]

    created = gcal(primary, "/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1",
                   "POST", body)
    meet = created.get("hangoutLink")

    # Optional: drop a hold on the other connected calendars so they show the time too.
    if cfg.get("mirror_to_other_calendars"):
        for acct in accounts:
            if acct["email"] == primary["email"]:
                continue
            try:
                gcal(acct, "/calendars/primary/events", "POST", {
                    "summary": summary,
                    "description": description + (f"\n\nJoin: {meet}" if meet else "")
                                   + f"\n\n(Hold: invite lives on {primary['email']})",
                    "start": body["start"], "end": body["end"],
                })
            except Exception as e:  # a failed mirror shouldn't fail the booking
                print("mirror failed:", acct["email"], e)
    _busy_cache.clear()
    return {"demo": False, "summary": summary, "meet_link": meet}


# ---------------------------------------------------------------- auth helpers
def sign(value):
    mac = hmac.new(SECRET, value.encode(), hashlib.sha256).hexdigest()
    return f"{value}.{mac}"


def unsign(signed):
    if not signed or "." not in signed:
        return None
    value, mac = signed.rsplit(".", 1)
    good = hmac.new(SECRET, value.encode(), hashlib.sha256).hexdigest()
    return value if hmac.compare_digest(mac, good) else None


def jwt_payload(token):
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


# ---------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "MicCal/1.0"

    # -- plumbing
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def send(self, code, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def redirect(self, url, headers=None):
        self.send(302, b"", "text/plain", dict({"Location": url}, **(headers or {})))

    def cookie(self, name):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c[name].value if name in c else None

    def set_cookie(self, name, value, max_age=None):
        secure = "; Secure" if BASE_URL.startswith("https") else ""
        age = f"; Max-Age={max_age}" if max_age is not None else ""
        return f"{name}={value}; Path=/; HttpOnly; SameSite=Lax{age}{secure}"

    def json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20000:
            raise ValueError("Body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def is_admin(self):
        return unsign(self.cookie("mc_admin")) == "admin"

    def static(self, rel):
        path = os.path.normpath(os.path.join(STATIC, rel))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self.send(404, {"error": "Not found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            cache = "no-cache" if path.endswith(".html") else "public, max-age=300"
            self.send(200, f.read(), ctype, {"Cache-Control": cache})

    # -- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        p = url.path
        try:
            if p.startswith("/static/"):
                return self.static(p[len("/static/"):])
            if p == "/api/config":
                return self.api_config()
            if p == "/api/slots":
                return self.api_slots(q)
            if p == "/admin":
                return self.static("admin.html")
            if p == "/admin/connect":
                return self.oauth_start()
            if p == "/oauth/callback":
                return self.oauth_callback(q)
            if p == "/api/admin/accounts":
                return self.api_accounts()
            if p == "/favicon.ico":
                return self.static("logo.png")
            # Everything else is the booking SPA: "/" (event list) or "/<slug>"
            return self.static("index.html")
        except Exception as e:
            print("ERROR", p, e)
            return self.send(500, {"error": str(e) if self.is_admin() else "Server error"})

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        try:
            body = self.json_body()
            routes = {
                "/api/book": self.api_book,
                "/api/admin/login": self.api_login,
                "/api/admin/logout": self.api_logout,
                "/api/admin/accounts/update": self.api_account_update,
                "/api/admin/accounts/remove": self.api_account_remove,
            }
            if p in routes:
                return routes[p](body)
            return self.send(404, {"error": "Not found"})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except Exception as e:
            print("ERROR", p, e)
            return self.send(500, {"error": str(e) if self.is_admin() else
                                   "Something went wrong. Please try again."})

    # -- public api
    def api_config(self):
        cfg = load_config()
        self.send(200, {
            "brand": cfg["brand"],
            "timezone": cfg["timezone"],
            "max_days_ahead": cfg.get("max_days_ahead", 60),
            "event_types": cfg["event_types"],
            "demo": not read_accounts(),
        })

    def api_slots(self, q):
        cfg = load_config()
        event = find_event(cfg, q.get("event", ""))
        if not event:
            return self.send(404, {"error": "Unknown event type"})
        try:
            start = parse_rfc3339(q["start"]).astimezone(timezone.utc)
            end = parse_rfc3339(q["end"]).astimezone(timezone.utc)
        except Exception:
            return self.send(400, {"error": "start and end must be ISO timestamps"})
        if end - start > timedelta(days=45):
            return self.send(400, {"error": "Range too large"})
        slots = compute_slots(cfg, event, start, end)
        self.send(200, {"slots": [iso_utc(s) for s in slots]})

    def api_book(self, b):
        cfg = load_config()
        event = find_event(cfg, str(b.get("event", "")))
        name = str(b.get("name", "")).strip()[:120]
        email = str(b.get("email", "")).strip()[:200]
        notes = str(b.get("notes", "")).strip()[:2000]
        guest_tz = str(b.get("timezone", ""))[:64]
        if not event:
            raise ValueError("Unknown event type")
        if not name or not EMAIL_RE.match(email):
            raise ValueError("Please enter your name and a valid email.")
        try:
            start = parse_rfc3339(str(b.get("start"))).astimezone(timezone.utc)
        except Exception:
            raise ValueError("Invalid start time") from None
        if rate_limited(self.client_address[0]):
            return self.send(429, {"error": "Too many booking attempts. Try again later."})
        with _book_lock:  # re-check live availability so two guests can't grab one slot
            fresh = compute_slots(cfg, event, start, start + timedelta(minutes=event["duration"]),
                                  use_cache=False)
            if start not in fresh:
                return self.send(409, {"error": "That time was just taken. Please pick another."})
            result = create_booking(cfg, event, start, name, email, notes, guest_tz)
        result.update({"start": iso_utc(start), "event": event["title"],
                       "duration": event["duration"]})
        self.send(200, result)

    # -- admin
    def api_login(self, b):
        if not ADMIN_PASSWORD:
            raise ValueError("Set ADMIN_PASSWORD in .env first.")
        time.sleep(0.4)  # slow brute force a little
        if not hmac.compare_digest(str(b.get("password", "")), ADMIN_PASSWORD):
            return self.send(401, {"error": "Wrong password"})
        self.send(200, {"ok": True},
                  headers={"Set-Cookie": self.set_cookie("mc_admin", sign("admin"), 60 * 60 * 12)})

    def api_logout(self, _b):
        self.send(200, {"ok": True}, headers={"Set-Cookie": self.set_cookie("mc_admin", "", 0)})

    def api_accounts(self):
        if not self.is_admin():
            return self.send(401, {"error": "Login required"})
        out = []
        for a in read_accounts():
            item = {"email": a["email"], "calendars": a.get("calendars") or ["primary"],
                    "book_to": bool(a.get("book_to")), "available": [], "error": None}
            try:
                lst = gcal(a, "/users/me/calendarList?minAccessRole=freeBusyReader")
                item["available"] = [{"id": c["id"], "name": c.get("summaryOverride") or c.get("summary"),
                                      "primary": bool(c.get("primary"))} for c in lst.get("items", [])]
            except Exception as e:
                item["error"] = str(e)
            out.append(item)
        cfg = load_config()
        self.send(200, {"accounts": out, "base_url": BASE_URL, "google_configured": bool(CLIENT_ID),
                        "redirect_uri": REDIRECT_URI,
                        "event_types": [{"slug": e["slug"], "title": e["title"]} for e in cfg["event_types"]]})

    def api_account_update(self, b):
        if not self.is_admin():
            return self.send(401, {"error": "Login required"})
        with _store_lock:
            accounts = read_accounts()
            for a in accounts:
                if a["email"] == b.get("email"):
                    if isinstance(b.get("calendars"), list):
                        a["calendars"] = [str(c) for c in b["calendars"]][:20] or ["primary"]
                    if b.get("book_to"):
                        for other in accounts:
                            other["book_to"] = other is a
            write_accounts(accounts)
        _busy_cache.clear()
        self.send(200, {"ok": True})

    def api_account_remove(self, b):
        if not self.is_admin():
            return self.send(401, {"error": "Login required"})
        with _store_lock:
            write_accounts([a for a in read_accounts() if a["email"] != b.get("email")])
        _busy_cache.clear()
        self.send(200, {"ok": True})

    def oauth_start(self):
        if not self.is_admin():
            return self.redirect("/admin")
        if not CLIENT_ID:
            return self.send(400, "Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env", "text/plain")
        state = secrets.token_urlsafe(24)
        params = urllib.parse.urlencode({
            "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI, "response_type": "code",
            "scope": SCOPES, "access_type": "offline", "prompt": "consent select_account",
            "include_granted_scopes": "true", "state": state,
        })
        self.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params,
                      {"Set-Cookie": self.set_cookie("mc_state", sign(state), 600)})

    def oauth_callback(self, q):
        if not self.is_admin():
            return self.redirect("/admin")
        if q.get("error"):
            return self.redirect("/admin?error=" + urllib.parse.quote(q["error"]))
        if not q.get("state") or unsign(self.cookie("mc_state")) != q.get("state"):
            return self.send(400, "OAuth state mismatch — try connecting again.", "text/plain")
        tok = http_json("https://oauth2.googleapis.com/token", "POST", {
            "code": q.get("code", ""), "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
            "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
        }, form=True)
        email = jwt_payload(tok["id_token"])["email"]
        if not tok.get("refresh_token"):
            return self.redirect("/admin?error=" + urllib.parse.quote(
                "Google didn't return a refresh token. Remove the app at myaccount.google.com/permissions and reconnect."))
        with _store_lock:
            accounts = [a for a in read_accounts() if a["email"] != email]
            accounts.append({"email": email, "refresh_token": tok["refresh_token"],
                             "calendars": ["primary"], "book_to": not accounts})
            write_accounts(accounts)
        _token_cache[email] = (tok["access_token"], time.time() + tok.get("expires_in", 3600))
        _busy_cache.clear()
        self.redirect("/admin?connected=" + urllib.parse.quote(email),
                      {"Set-Cookie": self.set_cookie("mc_state", "", 0)})


if __name__ == "__main__":
    mode = f"{len(read_accounts())} Google account(s) connected" if read_accounts() else "DEMO MODE (no calendars connected)"
    print(f"MicCal running on {BASE_URL}  —  {mode}")
    print(f"Admin: {BASE_URL}/admin")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
