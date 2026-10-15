#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse


def request(method, url, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8") if resp.read else ""
            payload = json.loads(raw) if raw else None
            return resp.status, payload
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8") if e.fp else ""
        try:
            payload = json.loads(raw) if raw else None
        except Exception:
            payload = raw
        return e.code, payload


def main():
    parser = argparse.ArgumentParser(description="Resy API smoke checks (read-only by default).")
    parser.add_argument("--base", default=os.getenv("RESY_API_BASE", "http://127.0.0.1:5000"), help="API base URL")
    parser.add_argument("--email", default=os.getenv("RESY_ADMIN_EMAIL", "admin@company.com"))
    parser.add_argument("--password", default=os.getenv("RESY_ADMIN_PASSWORD", ""))
    parser.add_argument(
        "--test-rejected-login",
        action="store_true",
        help="Create one sanitized rejected-sign-in warning and verify it through Diagnostics.",
    )
    args = parser.parse_args()

    base = args.base.rstrip("/")
    print(f"API base: {base}")
    if not args.password:
        print("[FAIL] Missing admin password. Pass --password or set RESY_ADMIN_PASSWORD.")
        return 1

    status, data = request("POST", f"{base}/api/auth/login", {"email": args.email, "password": args.password})
    if status not in (200, 201) or not data or "token" not in data:
        print(f"[FAIL] Login {status} {data}")
        return 1
    token = data["token"]
    print("[OK] Login")

    if args.test_rejected_login:
        attempted_identity = f"diagnostics-probe-{int(time.time())}@example.invalid"
        status, rejected = request(
            "POST",
            f"{base}/api/auth/login",
            {"email": attempted_identity, "password": "intentionally-wrong-password"},
        )
        if status != 401:
            print(f"[FAIL] Rejected-sign-in probe {status} {rejected}")
            return 1
        query = urllib.parse.quote("Sign-in attempt rejected")
        status, diagnostics = request(
            "GET",
            f"{base}/api/admin/diagnostics?severity=warning&query={query}&limit=10",
            token=token,
        )
        events = diagnostics.get("events", []) if isinstance(diagnostics, dict) else []
        event = events[0] if events else None
        if (
            status != 200
            or not isinstance(event, dict)
            or event.get("source") != "authentication"
            or event.get("category") != "login_rejected"
            or attempted_identity in json.dumps(event)
        ):
            print(f"[FAIL] Rejected-sign-in diagnostic {status} {diagnostics}")
            return 1
        print("[OK] Rejected sign-in recorded without attempted identity")

    checks = [
        ("Settings", "GET", "/api/settings", None),
        ("Rules", "GET", "/api/admin/rules", None),
        ("Buildings", "GET", "/api/admin/buildings", None),
        ("Rooms", "GET", "/api/admin/rooms", None),
        ("Booking Reports", "GET", "/api/admin/analytics", None),
        ("Users", "GET", "/api/admin/users", None),
        ("My Bookings", "GET", "/api/bookings/my-bookings", None),
        ("Paginated Booking History", "GET", "/api/bookings/my-bookings?scope=history&limit=10&offset=0", None),
        ("Retention Preview", "GET", "/api/admin/retention", None),
        ("Diagnostics Summary", "GET", "/api/admin/diagnostics/summary", None),
        ("Diagnostics Events", "GET", "/api/admin/diagnostics?limit=5", None),
    ]

    for label, method, path, payload in checks:
        status, data = request(method, f"{base}{path}", payload, token=token)
        if status >= 400:
            print(f"[FAIL] {label} {status} {data}")
            return 1
        print(f"[OK] {label}")

        if label == "Paginated Booking History" and (
            not isinstance(data, dict) or not isinstance(data.get("bookings"), list) or "total" not in data
        ):
            print(f"[FAIL] Paginated Booking History response shape {data}")
            return 1
        if label == "Retention Preview" and (
            not isinstance(data, dict) or not isinstance(data.get("retention_months"), int)
            or data.get("retention_months", 0) < 1 or "eligible_count" not in data
        ):
            print(f"[FAIL] Retention Preview response shape {data}")
            return 1
        if label == "Booking Reports" and (
            not isinstance(data, dict) or "summary" not in data or not isinstance(data.get("roomUsage"), list)
        ):
            print(f"[FAIL] Booking Reports response shape {data}")
            return 1
        if label == "Diagnostics Summary" and (
            not isinstance(data, dict) or not isinstance(data.get("api"), dict)
            or not isinstance(data.get("database"), dict) or "errors_24h" not in data
            or "warnings_24h" not in data
        ):
            print(f"[FAIL] Diagnostics Summary response shape {data}")
            return 1
        if label == "Diagnostics Events" and (
            not isinstance(data, dict) or not isinstance(data.get("events"), list)
            or "total" not in data or "retention_days" not in data
        ):
            print(f"[FAIL] Diagnostics Events response shape {data}")
            return 1

    print("Smoke checks completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
