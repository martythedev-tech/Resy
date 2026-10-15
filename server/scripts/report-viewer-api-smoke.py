#!/usr/bin/env python3
import argparse
import json
import time
import urllib.error
import urllib.request


def request(method, url, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8") if error.fp else ""
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw
        return error.code, payload


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description="Reports Viewer authorization regression")
    parser.add_argument("--base", default="http://127.0.0.1:5000")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    status, login = request("POST", f"{base}/api/auth/login", {"email": args.email, "password": args.password})
    require(status in (200, 201) and isinstance(login, dict) and login.get("token"), f"Admin login failed: {status} {login}")
    admin_token = login["token"]

    suffix = int(time.time())
    viewer_email = f"reports-viewer-{suffix}@example.invalid"
    viewer_password = "reports-viewer-test-password"
    viewer_id = None
    try:
        status, created = request("POST", f"{base}/api/admin/users", {
            "email": viewer_email,
            "password": viewer_password,
            "name": "Reports Viewer Regression",
            "role": "report_viewer",
            "must_reset_password": False,
        }, admin_token)
        require(status == 201 and isinstance(created, dict), f"Viewer creation failed: {status} {created}")
        require(created.get("role") == "report_viewer", f"Unexpected created role: {created}")
        require(not created.get("receives_admin_notifications"), f"Reports Viewer unexpectedly receives admin mail: {created}")
        viewer_id = created.get("id")

        status, viewer_login = request("POST", f"{base}/api/auth/login", {"email": viewer_email, "password": viewer_password})
        require(status in (200, 201) and isinstance(viewer_login, dict) and viewer_login.get("token"), f"Viewer login failed: {status} {viewer_login}")
        viewer_token = viewer_login["token"]

        status, report = request("GET", f"{base}/api/admin/analytics", token=viewer_token)
        require(status == 200 and isinstance(report, dict), f"Reports access failed: {status} {report}")
        require(isinstance(report.get("exportRows"), list), f"Report export rows missing: {report}")
        if report["exportRows"]:
            require("organizer" in report["exportRows"][0], f"Organizer field missing from export rows: {report['exportRows'][0]}")

        denied = [
            "/api/admin/buildings",
            "/api/admin/bookings/pending",
            "/api/admin/users",
            "/api/admin/site-config",
            "/api/admin/diagnostics/summary",
        ]
        for path in denied:
            status, payload = request("GET", f"{base}{path}", token=viewer_token)
            require(status == 403, f"Viewer was not denied {path}: {status} {payload}")

        status, updated = request("PATCH", f"{base}/api/admin/users/{viewer_id}", {"role": "user"}, admin_token)
        require(status == 200 and updated.get("role") == "user", f"Viewer demotion failed: {status} {updated}")
        status, payload = request("GET", f"{base}/api/admin/analytics", token=viewer_token)
        require(status == 403, f"Standard user retained Reports access: {status} {payload}")

        print("[OK] Reports Viewer can read and export analytics")
        print("[OK] Reports Viewer is denied all sampled administrative endpoints")
        print("[OK] Standard users remain denied Reports access")
    finally:
        if viewer_id is not None:
            status, payload = request("DELETE", f"{base}/api/admin/users/{viewer_id}", token=admin_token)
            require(status == 200, f"Viewer cleanup failed: {status} {payload}")


if __name__ == "__main__":
    main()
