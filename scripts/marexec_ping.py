# What this does, in plain English:
# Asks Linear what changed on a shared team since the last check, and
# prints JSON {"pings": [...], "issues": [...], "answered": {...}}: the changes worth a ping,
# every open issue (for the mod's pane), and, for each issue that changed, when your own side
# last commented on it (so the pane can clear a card that was answered elsewhere). A ping is:
#   1. a comment by anyone other than the person signed in, or
#   2. an issue moving into your "waiting on us" status (--waiting).
# Read-only on Linear. Two ways in (--server):
#   - Linear's own MCP server (default https://mcp.linear.app/mcp), signed in as you once with
#     --login (browser sign-in). Tokens live in ~/.marexec-ping/auth.json, encrypted for your
#     Windows login (DPAPI), or readable only by you on Mac/Linux. Refreshed by itself.
#   - Aperture (any http:// address, e.g. http://aperture/v1/mcp): no keys, Aperture trusts this
#     machine's Tailscale identity. --connector names its Linear connection (e.g. "Linear" or
#     "Linearjoe"); its tools are then called "<connector>_list_issues" and so on.
# An empty --connector (the default) calls the tools by their bare names (list_issues, ...).
# Remembers what it saw in ~/.marexec-ping/state.json (or $MAREXEC_PING_HOME). The first run only
# records what is there now and prints []. A failed call exits 1, logs to errors.log and does
# NOT move the "last checked" time, so nothing is skipped. Two copies never run at once.
# It also does the two writes the pane's buttons ask for, only when called for them:
#   --post MAREXEC-7   posts the text it reads on stdin as a comment (as the signed-in login)
#   --move MAREXEC-7 --status "Waiting on Marco's Team"   moves the issue to that status
# Usage: python3 marexec_ping.py --login        (once: opens Linear in the browser, click Authorize)
#        python3 marexec_ping.py --team "Marco - Exec" --waiting "Waiting on Joe's Team"
#        python3 marexec_ping.py --selftest   (offline checks, no network)
# Exit 2 = the Linear sign-in is missing or expired: run --login again.
import argparse, base64, hashlib, http.server, json, os, secrets, sys, time, urllib.error, urllib.parse, urllib.request, webbrowser
from datetime import datetime, timedelta, timezone

HOME = os.environ.get("MAREXEC_PING_HOME") or os.path.join(os.path.expanduser("~"), ".marexec-ping")
STATE = os.path.join(HOME, "state.json")
LOCK = os.path.join(HOME, "lock")
ERRLOG = os.path.join(HOME, "errors.log")
LINEAR_MCP = "https://mcp.linear.app/mcp"
SIGN_IN_AGAIN = "Linear sign-in needed: run /marexec-login (or marexec_ping.py --login), then try again."
UA = {"User-Agent": "marexec-ping/0.3", "Accept": "application/json"}


class AuthError(Exception):
    pass


def tool(connector, name):
    """Aperture prefixes each tool with its connection name; Linear's own server does not."""
    return f"{connector}_{name}" if connector else name


def s256(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def pkce():
    v = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    return v, s256(v)


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _post(url, data, as_json=False):
    body = json.dumps(data).encode() if as_json else urllib.parse.urlencode(data).encode()
    ct = "application/json" if as_json else "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, body, dict(UA, **{"Content-Type": ct}), method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def _dpapi(data, protect):
    """Windows DPAPI: only this Windows login on this machine can decrypt."""
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("n", wintypes.DWORD), ("p", ctypes.POINTER(ctypes.c_char))]
    buf = ctypes.create_string_buffer(data, len(data))
    src, out = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), Blob()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):  # 0x1: never show UI
        raise OSError("DPAPI failed")
    try:
        return ctypes.string_at(out.p, out.n)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(out.p, ctypes.c_void_p))


def _seal(b):
    return b"dpapi:" + base64.b64encode(_dpapi(b, True)) if os.name == "nt" else b


def _unseal(b):
    return _dpapi(base64.b64decode(b[6:]), False) if b.startswith(b"dpapi:") else b


def _write_private(path, b):
    """Owner-only file (chmod 600 on Mac/Linux), swapped in whole so a crash never leaves half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(b)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


class Auth:
    """The Linear sign-in: {server, client_id, token_endpoint, refresh_token, access_token, expires_at}."""
    path = os.path.join(HOME, "auth.json")

    def __init__(self, d, post=None):
        self.d, self.post = d, post or _post

    @classmethod
    def load(cls, server):
        try:
            d = json.loads(_unseal(open(cls.path, "rb").read()))
        except Exception:
            raise AuthError(SIGN_IN_AGAIN) from None
        if d.get("server") != server:
            raise AuthError(SIGN_IN_AGAIN)
        return cls(d)

    def save(self):
        _write_private(self.path, _seal(json.dumps(self.d).encode()))

    def take(self, t):
        if not t.get("access_token"):
            raise AuthError(SIGN_IN_AGAIN)
        self.d.update(access_token=t["access_token"], expires_at=time.time() + float(t.get("expires_in") or 3600))
        if t.get("refresh_token"):  # the server may rotate it
            self.d["refresh_token"] = t["refresh_token"]

    def token(self):
        if time.time() > self.d.get("expires_at", 0) - 60:
            self.refresh()
        return self.d["access_token"]

    def refresh(self):
        if not self.d.get("refresh_token"):
            raise AuthError(SIGN_IN_AGAIN)
        try:
            t = self.post(self.d["token_endpoint"], {"grant_type": "refresh_token", "refresh_token": self.d["refresh_token"],
                                                     "client_id": self.d["client_id"], "resource": self.d["server"]})
        except urllib.error.HTTPError as e:
            if e.code in (400, 401):  # refresh token revoked or expired; anything else is an ordinary failed check
                raise AuthError(SIGN_IN_AGAIN) from None
            raise
        self.take(t)
        self.save()


class Mcp:
    """MCP over Streamable HTTP. auth=None is Aperture mode: no header, Aperture trusts the tailnet."""
    def __init__(self, url, auth=None, opener=None):
        self.url, self.auth, self.sid, self.proto = url, auth, None, None
        self.open = opener or urllib.request.urlopen
        r = self._rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "marexec-ping", "version": "0.3"}}})
        self.proto = ((r or {}).get("result") or {}).get("protocolVersion")
        self._rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _rpc(self, obj, retry=True):
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": UA["User-Agent"]}
        if self.sid:
            h["Mcp-Session-Id"] = self.sid
        if self.proto:
            h["MCP-Protocol-Version"] = self.proto
        if self.auth:
            h["Authorization"] = "Bearer " + self.auth.token()
        req = urllib.request.Request(self.url, json.dumps(obj).encode(), h, method="POST")
        try:
            with self.open(req, timeout=60) as r:
                self.sid = r.headers.get("Mcp-Session-Id") or self.sid
                t = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 401 and self.auth and retry:  # token went stale early: refresh once, try again
                self.auth.refresh()
                return self._rpc(obj, False)
            if e.code == 401 and self.auth:
                raise AuthError(SIGN_IN_AGAIN) from None
            raise
        if "data:" in t:
            t = [l[5:] for l in t.splitlines() if l.startswith("data:")][-1]
        return json.loads(t) if t.strip() else None

    def call(self, tool, args):
        res = self._rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                         "params": {"name": tool, "arguments": args}})
        if res.get("error") or res["result"].get("isError"):
            raise RuntimeError(f"{tool} failed")  # no response text: it may hold data
        return json.loads("".join(c.get("text", "") for c in res["result"]["content"]))

    def all_pages(self, tool, args, key):
        out, cursor = [], None
        while True:
            page = self.call(tool, dict(args, **({"cursor": cursor} if cursor else {})))
            out += page[key]
            if not page.get("hasNextPage"):
                return out
            cursor = page["cursor"]


def connect(a, opener=None):
    # A Bearer token only ever goes over https. Plain http is Aperture on the tailnet: no token at all.
    return Mcp(a.server, Auth.load(a.server) if a.server.startswith("https://") else None, opener)


class _Catch(http.server.BaseHTTPRequestHandler):
    """Catches the browser coming back from Linear with ?code=... on 127.0.0.1."""
    def do_GET(self):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
        if "code" in q or "error" in q:
            self.server.got = q
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Signed in. You can close this tab and go back to Claude Code." if "code" in q
                         else b"Sign-in did not finish. Go back to Claude Code.")

    def log_message(self, *args):  # never print the code
        pass


def login(a):
    """OAuth 2.1 sign-in: discover the server's sign-in endpoints, register this copy (DCR) unless
    --client-id is given, open the browser, catch the code on 127.0.0.1, swap it (with PKCE) for tokens."""
    if not a.server.startswith("https://"):
        print("This address is Aperture: it needs no sign-in.")
        return
    u = urllib.parse.urlsplit(a.server)
    origin = f"{u.scheme}://{u.netloc}"
    try:
        prm = _get(f"{origin}/.well-known/oauth-protected-resource{u.path}")
    except urllib.error.HTTPError:
        prm = _get(f"{origin}/.well-known/oauth-protected-resource")
    issuer = prm["authorization_servers"][0].rstrip("/")
    asm = _get(f"{issuer}/.well-known/oauth-authorization-server")
    srv = http.server.HTTPServer(("127.0.0.1", a.port), _Catch)
    srv.timeout, srv.got = 5, None
    redirect = f"http://127.0.0.1:{srv.server_port}/callback"
    client_id = a.client_id
    if not client_id:
        if not asm.get("registration_endpoint"):
            raise SystemExit("This server does not let apps register themselves. Ask Joe for a client id, "
                             "then run --login --client-id <id> --port <its redirect port>.")
        client_id = _post(asm["registration_endpoint"], {
            "client_name": "marexec-ping", "redirect_uris": [redirect], "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]}, as_json=True)["client_id"]
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(24)
    url = asm["authorization_endpoint"] + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect, "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", "resource": a.server,
        "scope": " ".join(prm.get("scopes_supported") or ["read", "write"])})
    print("Opening Linear in your browser. Click Authorize there within 4 minutes.", flush=True)
    if not webbrowser.open(url):
        print("No browser opened. Open this address yourself:\n" + url, flush=True)
    end = time.time() + 240  # under the mod's 5-minute limit on the script
    try:
        while srv.got is None and time.time() < end:
            srv.handle_request()
    finally:
        srv.server_close()
    q = srv.got or {}
    if q.get("state") != state or "code" not in q:
        raise SystemExit("Sign-in did not finish (no answer, denied, or a mismatched reply). Run it again.")
    if q.get("iss") and q["iss"].rstrip("/") != asm.get("issuer", issuer).rstrip("/"):
        raise SystemExit("Sign-in answer came from the wrong server. Run it again.")
    t = _post(asm["token_endpoint"], {"grant_type": "authorization_code", "code": q["code"], "redirect_uri": redirect,
                                      "client_id": client_id, "code_verifier": verifier, "resource": a.server})
    auth = Auth({"server": a.server, "client_id": client_id, "token_endpoint": asm["token_endpoint"],
                 "refresh_token": t.get("refresh_token")})
    auth.take(t)
    auth.save()
    me = Mcp(a.server, auth).call(tool(a.connector, "whoami"), {})["user"]
    print(f"Signed in to Linear as {me.get('name') or me.get('email') or 'you'}.")


def _after(a, b):
    """True only when ISO time a is clearly later than ISO time b. Anything unreadable is False."""
    try:
        p = lambda t: datetime.fromisoformat(t.replace("Z", "+00:00"))
        return p(a) > p(b)
    except Exception:
        return False


def find_pings(issues, state, me, waiting):
    """issues: [{id, title, status, comments:[{id, author:{id,name}}]}]. Returns (pings, new_state)."""
    seen = set(state.get("seen_comments", []))
    status = dict(state.get("status", {}))
    first = not state.get("last_run")
    pings = []
    for i in issues:
        # A comment on an issue that is already closed needs no drafted reply: flag it so the
        # mod shows it without waking the session.
        closed = i.get("statusType") in ("completed", "canceled")
        # An issue the signed-in login just created straight into your own Waiting status is not
        # a hand-back, so it gets no "moved" ping. Only that one case is skipped, and only when the
        # issue was created since the last check: an older issue this state file has simply never
        # seen (fresh install, deleted state, untouched for 14 days) still pings, whoever moved it.
        own_new = bool(me) and i.get("createdById") == me and i["id"] not in status \
            and _after(i.get("createdAt"), state.get("last_run"))
        if not first and not own_new and i["status"] == waiting and status.get(i["id"]) != waiting:
            pings.append({"id": i["id"], "text": f'{i["id"]} moved to {waiting}: {i["title"]}'})
        status[i["id"]] = i["status"]
        for c in i["comments"]:
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            who = c.get("author") or {}
            if not first and who.get("id") != me:
                pings.append({"id": i["id"], "closed": closed,
                              "text": f'{i["id"]} new comment from {who.get("name", "someone")}: {i["title"]}'})
    return pings, {"seen_comments": sorted(seen), "status": status}


def run(a):
    now = datetime.now(timezone.utc)
    state = json.load(open(STATE, encoding="utf-8")) if os.path.exists(STATE) else {}
    # 5-minute overlap so a change landing mid-run is never missed (seen ids stop repeats).
    since = (datetime.fromisoformat(state["last_run"]) - timedelta(minutes=5)).isoformat() if state.get("last_run") else "-P14D"
    ap = connect(a)
    L = a.connector
    # "me" belongs to the connection's workspace: ask again when the connector or server changes.
    me = state.get("me") if state.get("connector", "Linear") == L and state.get("server", a.server) == a.server else None
    me = me or ap.call(tool(L, "whoami"), {})["user"]["id"]
    issues = ap.all_pages(tool(L, "list_issues"), {"team": a.team, "updatedAt": since, "limit": 250,
                                                 "fields": ["id", "title", "status", "statusType", "updatedAt", "createdById", "createdAt"]}, "issues")
    for i in issues:
        i["comments"] = ap.all_pages(tool(L, "list_comments"), {"issueId": i["id"], "limit": 250}, "comments")
    pings, new_state = find_pings(issues, state, me, a.waiting)
    open_ = [{k: i[k] for k in ("id", "title", "status", "updatedAt")}
             for i in ap.all_pages(tool(L, "list_issues"), {"team": a.team, "limit": 250,
                                   "fields": ["id", "title", "status", "statusType", "updatedAt"]}, "issues")
             if i.get("statusType") not in ("completed", "canceled")]
    answered = {}
    for i in issues:
        mine = [c["createdAt"] for c in i["comments"] if (c.get("author") or {}).get("id") == me]
        if mine:
            answered[i["id"]] = int(datetime.fromisoformat(max(mine).replace("Z", "+00:00")).timestamp() * 1000)
    if not open_:
        # A shared board always has open issues; none means the wrong connector or team, never "quiet".
        raise RuntimeError(f"no open issues on team {a.team!r} via connector {L!r}: wrong connector or team?")
    new_state.update(me=me, connector=L, server=a.server, last_run=now.isoformat())
    tmp = STATE + ".tmp"
    json.dump(new_state, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, STATE)
    print(json.dumps({"pings": pings, "issues": open_, "answered": answered}))


def write(a):
    ap = connect(a)
    if a.post:
        body = sys.stdin.read().strip()
        if not body:
            raise ValueError("empty comment")
        # The same text already on the issue (a double click, a second session) is not posted twice.
        recent = ap.call(tool(a.connector, "list_comments"), {"issueId": a.post, "limit": 10})["comments"]
        if any((c.get("body") or "").strip() == body for c in recent):
            print(json.dumps({"ok": True, "duplicate": True}))
            return
        ap.call(tool(a.connector, "save_comment"), {"issueId": a.post, "body": body})
    else:
        ap.call(tool(a.connector, "save_issue"), {"id": a.move, "state": a.status})
    print(json.dumps({"ok": True}))


def selftest():
    W = "Waiting on Joe's Team"
    iss = lambda st, cs: [{"id": "MAREXEC-1", "title": "t", "status": st, "comments": cs}]
    joe, den = {"id": "me", "name": "Joe"}, {"id": "d", "name": "Marco"}
    p, s = find_pings(iss("Todo", [{"id": "c1", "author": den}]), {}, "me", W)
    assert p == [], "first run must be silent"
    s["last_run"] = "x"
    p, s2 = find_pings(iss("Todo", [{"id": "c1", "author": den}, {"id": "c2", "author": joe}]), s, "me", W)
    assert p == [], "seen comment and my own comment must not ping"
    s2["last_run"] = "x"
    p, s3 = find_pings(iss(W, [{"id": "c3", "author": den}]), s2, "me", W)
    assert len(p) == 2 and "moved" in p[0]["text"] and "Marco" in p[1]["text"] and p[0]["id"] == "MAREXEC-1", p
    s3["last_run"] = "x"
    p, _ = find_pings(iss(W, [{"id": "c3", "author": den}]), s3, "me", W)
    assert p == [], "no repeat pings"
    done = [{"id": "MAREXEC-2", "title": "t", "status": "Done", "statusType": "completed", "comments": [{"id": "c9", "author": den}]}]
    p, _ = find_pings(done, s3, "me", W)
    assert len(p) == 1 and p[0]["closed"] is True, "a comment on a closed issue is flagged closed"
    p, _ = find_pings(iss("Todo", [{"id": "c8", "author": den}]), s3, "me", W)
    assert len(p) == 1 and p[0]["closed"] is False, "a comment on an open issue is not flagged closed"
    T0, T1, OLD = "2026-11-18T10:00:00+00:00", "2026-11-18T10:05:00.000Z", "2026-10-01T10:00:00.000Z"
    s3["last_run"] = T0
    new = lambda by, at=T1: [{"id": "MAREXEC-9", "title": "t", "status": W, "createdById": by, "createdAt": at, "comments": []}]
    p, s4 = find_pings(new("me"), s3, "me", W)
    assert p == [], "an issue I created since the last check in my own Waiting status must not ping"
    p, _ = find_pings(new("d"), s3, "me", W)
    assert len(p) == 1 and "moved" in p[0]["text"], "an issue the other side created in my Waiting status pings"
    p, _ = find_pings(new("me", OLD), s3, "me", W)
    assert len(p) == 1, "an OLD issue of mine this state never saw, now in my Waiting status, pings"
    for bad in (None, "", "not a date"):
        p, _ = find_pings(new("me", bad), s3, "me", W)
        assert len(p) == 1, "an unreadable created time must ping, never hide"
    p, _ = find_pings([{"id": "MAREXEC-9", "title": "t", "status": W, "comments": []}], s3, None, W)
    assert len(p) == 1, "no login and no creator must ping, never hide"
    s4["last_run"] = T0
    back = [{"id": "MAREXEC-1", "title": "t", "status": W, "createdById": "me", "comments": []}]
    gone = dict(s4, status=dict(s4["status"], **{"MAREXEC-1": "Waiting on Marco's Team"}))
    p, _ = find_pings(back, gone, "me", W)
    assert len(p) == 1 and "moved" in p[0]["text"], "an issue I created that is handed back to me still pings"
    # 0.3.0: tool names, PKCE, the token file, the Bearer header and refresh on 401 (all offline).
    assert tool("", "whoami") == "whoami" and tool("Linear", "list_issues") == "Linear_list_issues"
    assert s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 B"
    v, c = pkce()
    assert 43 <= len(v) <= 128 and c == s256(v) and "=" not in v + c and pkce()[0] != v
    import tempfile
    from types import SimpleNamespace as NS

    class Resp:
        def __init__(self, text):
            self.text, self.headers = text, {"Mcp-Session-Id": "s1"}

        def read(self):
            return self.text.encode()

        def __enter__(self):
            return self

        def __exit__(self, *e):
            pass
    sent = []

    def opener(req, timeout=None):  # a fake MCP server: tools/call answers over SSE; "Bearer old" gets 401
        body, bearer = json.loads(req.data), req.get_header("Authorization")
        sent.append((body["method"], bearer, req.get_header("Mcp-session-id")))
        if bearer == "Bearer old" and body["method"] == "tools/call":
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)
        if "id" not in body:
            return Resp("")
        if body["method"] == "initialize":
            return Resp(json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}}))
        out = {"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": json.dumps({"user": {"id": "u1"}})}]}}
        return Resp("event: message\ndata: " + json.dumps(out) + "\n\n")
    old_path, srv = Auth.path, "https://mcp.example/mcp"
    with tempfile.TemporaryDirectory() as d:
        Auth.path = os.path.join(d, "auth.json")
        try:
            try:
                Auth.load(srv)
                assert False, "no auth file must ask for sign-in"
            except AuthError:
                pass
            secret = "refresh-secret-7f3a9c"
            Auth({"server": srv, "client_id": "cid", "token_endpoint": "https://mcp.example/token",
                  "refresh_token": secret, "access_token": "old", "expires_at": time.time() + 3600}).save()
            raw = open(Auth.path, "rb").read()
            if os.name == "nt":
                assert raw.startswith(b"dpapi:") and secret.encode() not in raw, "token file is DPAPI-encrypted"
            else:
                assert os.stat(Auth.path).st_mode & 0o777 == 0o600, "token file is owner-only"
            A = Auth.load(srv)
            assert A.d["refresh_token"] == secret and A.d["access_token"] == "old", "round trip"
            try:
                Auth.load("https://other.example/mcp")
                assert False, "a sign-in for another server is not used"
            except AuthError:
                pass
            posts = []
            A.post = lambda url, data: posts.append(data) or {"access_token": "new", "expires_in": 3600, "refresh_token": "r2"}
            m = Mcp(srv, A, opener)
            assert m.call("whoami", {})["user"]["id"] == "u1", "SSE answer read after refresh"
            assert posts and posts[0]["grant_type"] == "refresh_token" and posts[0]["refresh_token"] == secret
            assert sent[-1][:2] == ("tools/call", "Bearer new") and sent[-1][2] == "s1", "retried with the new token"
            assert all(b and b.startswith("Bearer ") for _, b, _ in sent), "Linear mode sends a Bearer on every request"
            B = Auth.load(srv)
            assert B.d["access_token"] == "new" and B.d["refresh_token"] == "r2", "refreshed tokens saved"

            def refused(url, data):
                raise urllib.error.HTTPError(url, 400, "invalid_grant", {}, None)
            B.post, B.d["expires_at"] = refused, 0
            try:
                B.token()
                assert False, "a refused refresh must ask for sign-in again"
            except AuthError as e:
                assert str(e) == SIGN_IN_AGAIN
            sent.clear()
            ap = connect(NS(server="http://aperture/v1/mcp"), opener)
            ap.call("Linear_whoami", {})
            assert ap.auth is None and sent and all(b is None for _, b, _ in sent), "Aperture mode sends no Bearer"
        finally:
            Auth.path = old_path
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", default="Marco - Exec")
    ap.add_argument("--waiting", default="Waiting on Joe's Team")
    # --aperture is the old name, kept so older callers still work.
    ap.add_argument("--server", "--aperture", dest="server", default=LINEAR_MCP,
                    help="MCP address: Linear's own (https, signed in with --login) or Aperture's (http)")
    ap.add_argument("--connector", default="", help="Aperture's name for its Linear connection; empty for Linear's own server")
    ap.add_argument("--login", action="store_true", help="sign in to Linear in the browser, once")
    ap.add_argument("--client-id", default="", help="only if the server has no self-registration: a client id Joe registered")
    ap.add_argument("--port", type=int, default=0, help="sign-in callback port on 127.0.0.1 (0 = any free port)")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--post")
    ap.add_argument("--move")
    ap.add_argument("--status")
    a = ap.parse_args()
    a.server = a.server or LINEAR_MCP  # an empty setting means the default, not ""
    if a.selftest:
        selftest()
        sys.exit()
    os.makedirs(HOME, exist_ok=True)
    if a.login:
        try:
            login(a)
        except SystemExit:
            raise
        except Exception as e:
            print(f"Sign-in failed: {type(e).__name__} {getattr(e, 'code', '')}".strip(), file=sys.stderr)
            sys.exit(1)
        sys.exit()
    if a.post or a.move:
        try:
            write(a)
        except AuthError:
            print(SIGN_IN_AGAIN, file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            with open(ERRLOG, "a", encoding="utf-8") as f:
                f.write(f"{datetime.now().isoformat()} write {type(e).__name__}: {str(e)[:200]}\n")
            print(f"error: {type(e).__name__}", file=sys.stderr)
            sys.exit(1)
        sys.exit()
    try:  # one copy at a time; a lock older than 15 minutes is a crashed run
        if os.path.exists(LOCK) and time.time() - os.path.getmtime(LOCK) > 900:
            os.remove(LOCK)
        os.close(os.open(LOCK, os.O_CREAT | os.O_EXCL))
    except FileExistsError:
        print("[]")
        sys.exit()
    try:
        run(a)
    except AuthError:
        with open(ERRLOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat()} {SIGN_IN_AGAIN}\n")
        print(SIGN_IN_AGAIN, file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        with open(ERRLOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat()} {type(e).__name__}: {str(e)[:200]}\n")
        print(f"error: {type(e).__name__}", file=sys.stderr)
        sys.exit(1)
    finally:
        os.remove(LOCK)
