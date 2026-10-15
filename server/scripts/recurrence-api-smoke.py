#!/usr/bin/env python3
import argparse
import calendar
import datetime as dt
import json
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo


def request(method, url, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw else None


def iso(local_date, hour, timezone, duration_minutes=60):
    start = dt.datetime.combine(local_date, dt.time(hour, 0), timezone)
    end = start + dt.timedelta(minutes=duration_minutes)
    return start.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), end.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def add_months_clamped(value, months, anchor_day=None):
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(anchor_day or value.day, calendar.monthrange(year, month)[1])
    return dt.date(year, month, day)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    timezone = ZoneInfo("America/Chicago")

    status, login = request("POST", f"{base}/api/auth/login", {"email": args.email, "password": args.password})
    require(status == 200 and login.get("token"), f"login failed: {status} {login}")
    token = login["token"]

    status, rules = request("GET", f"{base}/api/admin/rules", token=token)
    require(status == 200, f"rules failed: {status} {rules}")
    for rule in rules:
        if rule["rule_type"] in {"advance_window", "advance_window_privileged", "max_concurrent_bookings"}:
            status, data = request("PATCH", f"{base}/api/admin/rules/{rule['id']}", {"is_enabled": False}, token)
            require(status == 200, f"disable {rule['rule_type']} failed: {status} {data}")

    hours = {str(day): {"enabled": True, "start": "06:00", "end": "22:00"} for day in range(7)}
    status, building = request("POST", f"{base}/api/admin/buildings", {"name": "Recurrence QA", "business_hours": {"days": hours}}, token)
    require(status == 201, f"building failed: {status} {building}")
    status, room = request("POST", f"{base}/api/admin/rooms", {
        "name": "Recurrence Room", "building": "Recurrence QA", "floor": 1, "capacity": 10,
        "equipment": [], "requires_approval": 0, "business_hours": {"days": hours}, "buffer_minutes": 0,
    }, token)
    require(status == 201, f"room failed: {status} {room}")
    room_id = room["id"]

    first_date = dt.datetime.now(timezone).date() + dt.timedelta(days=10)
    conflict_date = first_date + dt.timedelta(days=2)
    conflict_start, conflict_end = iso(conflict_date, 10, timezone)
    status, data = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Existing conflict", "start_time": conflict_start, "end_time": conflict_end,
    }, token)
    require(status == 201, f"conflict seed failed: {status} {data}")

    status, before = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    require(status == 200, f"booking count failed: {status} {before}")
    series_start, series_end = iso(first_date, 10, timezone)
    status, conflict = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Atomic conflict series", "start_time": series_start, "end_time": series_end,
        "is_recurring": True,
        "recurrence": {"frequency": "daily", "interval": 1, "end_date": (first_date + dt.timedelta(days=4)).isoformat()},
    }, token)
    require(status == 409 and "unavailable" in conflict.get("error", ""), f"series conflict was not reported: {status} {conflict}")
    status, after = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    require(len(after) == len(before), "conflicting series left a partial booking behind")

    long_start, long_end = iso(first_date, 12, timezone)
    status, created = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Long recurrence QA", "start_time": long_start, "end_time": long_end,
        "is_recurring": True,
        "recurrence": {"frequency": "daily", "interval": 1, "end_date": (first_date + dt.timedelta(days=60)).isoformat()},
    }, token)
    require(status == 201, f"long series failed: {status} {created}")
    require(created.get("recurrence_result", {}).get("created_count") == 61, f"series was truncated: {created}")

    status, bookings = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    series = sorted((item for item in bookings if item["title"] == "Long recurrence QA"), key=lambda item: item["start_time"])
    require(len(series) == 61, f"expected 61 meetings, found {len(series)}")
    second = series[1]
    second_local_date = dt.datetime.fromisoformat(second["start_time"].replace("Z", "+00:00")).astimezone(timezone).date()
    update_start, update_end = iso(second_local_date, 13, timezone)
    status, updated = request("PATCH", f"{base}/api/bookings/{second['id']}", {
        "title": "Updated recurrence QA", "start_time": update_start, "end_time": update_end, "series_scope": "following",
    }, token)
    require(status == 200 and updated.get("affected_count") == 60, f"following update failed: {status} {updated}")

    status, bookings = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    updated_series = sorted((item for item in bookings if item["title"] == "Updated recurrence QA"), key=lambda item: item["start_time"])
    require(len(updated_series) == 60, f"following update count wrong: {len(updated_series)}")
    require(all(dt.datetime.fromisoformat(item["start_time"].replace("Z", "+00:00")).astimezone(timezone).hour == 13 for item in updated_series), "following update did not preserve local wall time")

    status, cancelled = request("POST", f"{base}/api/bookings/{second['id']}/cancel", {
        "reason": "recurrence QA", "series_scope": "following",
    }, token)
    require(status == 200 and cancelled.get("affected_count") == 60, f"following cancel failed: {status} {cancelled}")

    monthly_anchor = dt.datetime.now(timezone).date() + dt.timedelta(days=80)
    while calendar.monthrange(monthly_anchor.year, monthly_anchor.month)[1] != 31:
        monthly_anchor = add_months_clamped(monthly_anchor.replace(day=1), 1).replace(day=1)
    monthly_anchor = monthly_anchor.replace(day=31)
    monthly_start, monthly_end = iso(monthly_anchor, 9, timezone)
    monthly_series_end = add_months_clamped(monthly_anchor, 3, 31)
    status, monthly_created = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Monthly recurrence QA", "start_time": monthly_start, "end_time": monthly_end,
        "is_recurring": True,
        "recurrence": {"frequency": "monthly", "interval": 1, "end_date": monthly_series_end.isoformat()},
    }, token)
    require(status == 201, f"monthly series failed: {status} {monthly_created}")
    status, bookings = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    monthly_series = sorted((item for item in bookings if item["title"] == "Monthly recurrence QA"), key=lambda item: item["start_time"])
    require(len(monthly_series) == 4, f"expected 4 monthly meetings, found {len(monthly_series)}")
    monthly_second = monthly_series[1]
    monthly_second_local = dt.datetime.fromisoformat(monthly_second["start_time"].replace("Z", "+00:00")).astimezone(timezone).date()
    new_monthly_anchor = monthly_second_local.replace(day=15)
    monthly_update_start, monthly_update_end = iso(new_monthly_anchor, 9, timezone)
    status, monthly_updated = request("PATCH", f"{base}/api/bookings/{monthly_second['id']}", {
        "start_time": monthly_update_start, "end_time": monthly_update_end, "series_scope": "following",
    }, token)
    require(status == 200 and monthly_updated.get("affected_count") == 3, f"monthly following update failed: {status} {monthly_updated}")
    status, bookings = request("GET", f"{base}/api/bookings?room_id={room_id}", token=token)
    monthly_following = sorted((item for item in bookings if item["title"] == "Monthly recurrence QA"), key=lambda item: item["start_time"])[1:]
    monthly_days = [dt.datetime.fromisoformat(item["start_time"].replace("Z", "+00:00")).astimezone(timezone).day for item in monthly_following]
    require(monthly_days == [15, 15, 15], f"monthly following update drifted by fixed days: {monthly_days}")

    invalid_start, invalid_end = iso(first_date + dt.timedelta(days=70), 16, timezone)
    status, invalid = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Invalid recurrence QA", "start_time": invalid_start, "end_time": invalid_end,
        "is_recurring": True,
        "recurrence": {"frequency": "daily", "interval": 0, "end_date": (first_date + dt.timedelta(days=75)).isoformat()},
    }, token)
    require(status == 400 and "interval" in invalid.get("error", "").lower(), f"invalid interval accepted: {status} {invalid}")

    print("Recurrence API regression checks passed")


if __name__ == "__main__":
    main()
