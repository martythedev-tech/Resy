#!/usr/bin/env python3
import argparse
import json
import urllib.error
import urllib.request


def request(method, url, payload=None, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw else None


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    status, login = request("POST", f"{base}/api/auth/login", {"email": args.email, "password": args.password})
    require(status in (200, 201) and login.get("token"), f"admin login failed: {status} {login}")
    token = login["token"]

    status, baseline = request("GET", f"{base}/api/admin/directory/status", token=token)
    require(status == 200 and baseline.get("config_source") == "environment", f"unexpected baseline: {status} {baseline}")

    payload = {
        "enabled": False,
        "directory_type": "ad",
        "server_url": "ldaps://directory.example.com:636",
        "base_dn": "DC=example,DC=com",
        "bind_dn": "CN=Resy Bind,OU=Service Accounts,DC=example,DC=com",
        "bind_password": "api-smoke-bind-secret",
        "ca_cert_path": "/app/certs",
        "tls_reject_unauthorized": True,
        "allow_insecure_ldap": False,
        "allow_local_fallback": True,
        "sync_roles": True,
        "sync_profile": True,
        "allowed_groups": "Resy-Users",
        "admin_groups": "CN=Resy-Admins,OU=Groups,DC=example,DC=com",
        "room_manager_groups": "Resy-Room-Managers\nResy-Facilities",
        "timeout_ms": 8000,
        "connect_timeout_ms": 5000,
    }

    try:
        status, saved = request("PUT", f"{base}/api/admin/directory/config", payload, token)
        require(status == 200 and saved.get("config_source") == "application", f"save failed: {status} {saved}")
        require(saved.get("has_bind_password") is True, f"password state missing: {saved}")
        require("bind_password" not in saved, "directory response exposed bind_password")
        require(saved.get("admin_groups") == ["CN=Resy-Admins,OU=Groups,DC=example,DC=com"], f"DN changed: {saved}")
        require(saved.get("room_manager_groups") == ["Resy-Room-Managers", "Resy-Facilities"], f"group list changed: {saved}")

        payload["bind_password"] = ""
        payload["base_dn"] = "DC=updated,DC=example,DC=com"
        status, updated = request("PUT", f"{base}/api/admin/directory/config", payload, token)
        require(status == 200 and updated.get("has_bind_password") is True, f"blank password did not preserve secret: {status} {updated}")
        require(updated.get("base_dn") == "DC=updated,DC=example,DC=com", f"update failed: {updated}")
    finally:
        request("DELETE", f"{base}/api/admin/directory/config", token=token)

    status, restored = request("GET", f"{base}/api/admin/directory/status", token=token)
    require(status == 200 and restored.get("config_source") == "environment", f"environment restore failed: {status} {restored}")
    print("Directory configuration API regression checks passed")


if __name__ == "__main__":
    main()
