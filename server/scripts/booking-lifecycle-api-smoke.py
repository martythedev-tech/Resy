#!/usr/bin/env python3
import argparse
import base64
import concurrent.futures
import datetime as dt
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo


def request(method, url, payload=None, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
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


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def iso(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def approval_token(booking_id, action, secret):
    def encode(value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    header = encode({"alg": "HS256", "typ": "JWT"})
    payload = encode({
        "type": "booking_approval",
        "bookingId": booking_id,
        "action": action,
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
    })
    unsigned = f"{header}.{payload}"
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{unsigned}.{signature}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--jwt-secret", default=os.getenv("JWT_SECRET", ""))
    args = parser.parse_args()
    base = args.base.rstrip("/")
    require(args.jwt_secret, "JWT secret is required for approval-link regression checks")

    status, login = request("POST", f"{base}/api/auth/login", {"email": args.email, "password": args.password})
    require(status == 200 and login.get("token"), f"admin login failed: {status} {login}")
    admin_token = login["token"]

    rejected_identity = "diagnostics-probe@example.invalid"
    status, rejected = request("POST", f"{base}/api/auth/login", {
        "email": rejected_identity, "password": "intentionally-wrong-password",
    })
    require(status == 401, f"invalid sign-in was not rejected: {status} {rejected}")
    diagnostic_query = urllib.parse.quote("Sign-in attempt rejected")
    status, diagnostic_events = request(
        "GET", f"{base}/api/admin/diagnostics?severity=warning&query={diagnostic_query}&limit=10", token=admin_token
    )
    require(status == 200 and diagnostic_events.get("events"),
            f"rejected sign-in was not recorded in Diagnostics: {status} {diagnostic_events}")
    auth_event = diagnostic_events["events"][0]
    require(auth_event.get("source") == "authentication" and auth_event.get("category") == "login_rejected",
            f"unexpected rejected-sign-in diagnostic: {auth_event}")
    require(rejected_identity not in json.dumps(auth_event),
            f"rejected-sign-in diagnostic exposed the attempted identity: {auth_event}")

    status, site_config = request("GET", f"{base}/api/admin/site-config", token=admin_token)
    require(status == 200, f"site config failed: {status} {site_config}")
    status, nullable_asset_update = request("PUT", f"{base}/api/admin/site-config", {
        "brand_tagline": site_config.get("brand_tagline") or "Room booking",
        "favicon_url": None,
    }, admin_token)
    require(status == 200, f"nullable favicon blocked unrelated branding save: {status} {nullable_asset_update}")

    rejected_branding_value = "diagnostics-must-not-store-this-value"
    status, rejected_branding = request("PUT", f"{base}/api/admin/site-config", {
        "favicon_url": {"invalid": rejected_branding_value},
    }, admin_token)
    require(status == 400, f"invalid branding value was not rejected: {status} {rejected_branding}")
    branding_diagnostic_query = urllib.parse.quote("Branding settings update rejected")
    status, branding_diagnostics = request(
        "GET", f"{base}/api/admin/diagnostics?severity=warning&query={branding_diagnostic_query}&limit=10",
        token=admin_token,
    )
    require(status == 200 and branding_diagnostics.get("events"),
            f"rejected branding save was not recorded in Diagnostics: {status} {branding_diagnostics}")
    branding_event = branding_diagnostics["events"][0]
    require(branding_event.get("source") == "branding" and branding_event.get("category") == "validation",
            f"unexpected branding diagnostic: {branding_event}")
    require(branding_event.get("metadata") == {"field": "favicon_url"},
            f"branding diagnostic metadata was not sanitized: {branding_event}")
    require(rejected_branding_value not in json.dumps(branding_event),
            f"branding diagnostic exposed the rejected value: {branding_event}")

    status, branding = request("GET", f"{base}/api/branding")
    require(status == 200, f"branding failed: {status} {branding}")
    timezone = ZoneInfo(branding.get("timezone") or "UTC")
    status, default_report = request("GET", f"{base}/api/admin/analytics", token=admin_token)
    report_today = dt.datetime.now(timezone).date()
    expected_report_start = (report_today - dt.timedelta(days=29)).isoformat()
    expected_report_end = (report_today + dt.timedelta(days=30)).isoformat()
    expected_default_range = {
        "startDate": expected_report_start,
        "endDate": expected_report_end,
        "days": 60,
    }
    actual_default_range = default_report.get("range", {}) if isinstance(default_report, dict) else {}
    require(status == 200 and all(actual_default_range.get(key) == value for key, value in expected_default_range.items()),
            f"default report range did not use workspace timezone: {status} {default_report.get('range') if isinstance(default_report, dict) else default_report}")
    default_summary = default_report.get("summary", {}) if isinstance(default_report, dict) else {}
    require(default_summary.get("checkInTrackedCount") == 0 and default_summary.get("checkInRate") is None and default_summary.get("noShowRate") is None,
            f"empty report fabricated attendance outcomes: {default_summary}")
    invalid_query = urllib.parse.urlencode({"start_date": "2026-02-31", "end_date": "2026-03-05"})
    status, invalid_report = request("GET", f"{base}/api/admin/analytics?{invalid_query}", token=admin_token)
    require(status == 400 and "valid" in invalid_report.get("error", "").lower(),
            f"impossible report date was accepted: {status} {invalid_report}")

    status, rules = request("GET", f"{base}/api/admin/rules", token=admin_token)
    require(status == 200, f"rules failed: {status} {rules}")
    for rule in rules:
        if rule["rule_type"] in {"min_lead_time", "advance_window", "advance_window_privileged", "max_concurrent_bookings"}:
            status, data = request("PATCH", f"{base}/api/admin/rules/{rule['id']}", {"is_enabled": False}, admin_token)
            require(status == 200, f"disable {rule['rule_type']} failed: {status} {data}")
        if rule["rule_type"] == "check_in_grace":
            status, data = request("PATCH", f"{base}/api/admin/rules/{rule['id']}", {"is_enabled": True, "value": 10}, admin_token)
            require(status == 200, f"enable check-in failed: {status} {data}")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S%f")
    hours = {str(day): {"enabled": True, "start": "00:00", "end": "23:59"} for day in range(7)}
    building_name = f"Booking Lifecycle QA {stamp}"
    status, building = request("POST", f"{base}/api/admin/buildings", {
        "name": building_name, "business_hours": {"days": hours},
    }, admin_token)
    require(status == 201, f"building failed: {status} {building}")
    status, room = request("POST", f"{base}/api/admin/rooms", {
        "name": f"Lifecycle Room {stamp}", "building": building_name, "floor": 1, "capacity": 20,
        "equipment": [], "requires_approval": 0, "business_hours": {"days": hours}, "buffer_minutes": 0,
    }, admin_token)
    require(status == 201, f"room failed: {status} {room}")
    room_id = room["id"]

    custom_schema = [
        {"id": "qa", "label": "QA note", "type": "text"},
        {"id": "purpose", "label": "Purpose", "type": "text"},
        {"id": "meeting_type", "label": "Meeting type", "type": "select", "options": ["Internal", "External"], "required": True},
    ]
    status, configured = request("PUT", f"{base}/api/admin/site-config", {"custom_fields": custom_schema}, admin_token)
    require(status == 200, f"custom field schema setup failed: {status} {configured}")

    now = dt.datetime.now(dt.timezone.utc)
    start = now + dt.timedelta(minutes=5)
    end = start + dt.timedelta(minutes=30)
    status, booking = request("POST", f"{base}/api/bookings", {
        "room_id": room_id,
        "title": f"Lifecycle QA {stamp}",
        "start_time": iso(start),
        "end_time": iso(end),
        "attendee_count": 7,
        "notes": "remove me",
        "custom_fields": {"qa": "remove me", "meeting_type": "Internal"},
    }, admin_token)
    require(status == 201 and booking.get("attendee_count") == 7, f"attendee count was not persisted: {status} {booking}")
    booking_id = booking["id"]

    status, invalid_custom = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Missing required custom field", "start_time": iso(start + dt.timedelta(hours=4)),
        "end_time": iso(end + dt.timedelta(hours=4)), "custom_fields": {"qa": "present"},
    }, admin_token)
    require(status == 400 and "required" in invalid_custom.get("error", "").lower(), f"required custom field was not enforced: {status} {invalid_custom}")
    status, invalid_custom = request("PATCH", f"{base}/api/bookings/{booking_id}", {
        "custom_fields": {"meeting_type": "Not configured"},
    }, admin_token)
    require(status == 400 and "configured option" in invalid_custom.get("error", "").lower(), f"custom select schema was not enforced: {status} {invalid_custom}")

    status, invalid = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Invalid attendee count", "start_time": iso(start + dt.timedelta(hours=1)),
        "end_time": iso(end + dt.timedelta(hours=1)), "attendee_count": -1,
        "custom_fields": {"meeting_type": "Internal"},
    }, admin_token)
    require(status == 400 and "attendee" in invalid.get("error", "").lower(), f"invalid attendee count accepted: {status} {invalid}")

    status, oversized = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Oversized booking", "start_time": iso(start + dt.timedelta(hours=2)),
        "end_time": iso(end + dt.timedelta(hours=2)), "notes": "x" * 5001,
        "custom_fields": {"meeting_type": "Internal"},
    }, admin_token)
    require(status == 400 and "notes" in oversized.get("error", "").lower(), f"oversized notes accepted: {status} {oversized}")

    status, oversized_list = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Oversized attendees", "start_time": iso(start + dt.timedelta(hours=2)),
        "end_time": iso(end + dt.timedelta(hours=2)), "attendees": [f"person-{index}" for index in range(101)],
        "custom_fields": {"meeting_type": "Internal"},
    }, admin_token)
    require(status == 400 and "attendees" in oversized_list.get("error", "").lower(), f"oversized attendee list accepted: {status} {oversized_list}")

    status, template = request("POST", f"{base}/api/bookings/templates", {
        "name": f"Clearable QA {stamp}", "title": "Clearable template", "duration_minutes": 30,
        "equipment": ["Projector"], "notes": "remove me", "custom_fields": {"purpose": "remove me", "attendee_count": 4},
    }, admin_token)
    require(status == 201, f"template setup failed: {status} {template}")
    status, cleared_template = request("PATCH", f"{base}/api/bookings/templates/{template['id']}", {
        "equipment": [], "notes": None, "custom_fields": {},
    }, admin_token)
    require(status == 200, f"template clear failed: {status} {cleared_template}")
    require(cleared_template.get("equipment") == "[]" and cleared_template.get("notes") is None and cleared_template.get("custom_fields") == "{}",
            f"template values were not cleared: {cleared_template}")

    status, restored = request("PUT", f"{base}/api/admin/site-config", {"custom_fields": []}, admin_token)
    require(status == 200, f"custom field schema restore failed: {status} {restored}")

    unknown_start = end + dt.timedelta(minutes=5)
    status, unknown_attendance_booking = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Unknown attendance QA", "start_time": iso(unknown_start),
        "end_time": iso(unknown_start + dt.timedelta(minutes=15)),
    }, admin_token)
    require(status == 201, f"unknown attendance setup failed: {status} {unknown_attendance_booking}")
    unknown_attendance_id = unknown_attendance_booking["id"]

    local_date = start.astimezone(timezone).date().isoformat()
    query = urllib.parse.urlencode({"start_date": local_date, "end_date": local_date, "room_id": room_id})
    status, report = request("GET", f"{base}/api/admin/analytics?{query}", token=admin_token)
    require(status == 200, f"report failed: {status} {report}")
    report_row = next((row for row in report.get("exportRows", []) if row.get("bookingId") == booking_id), None)
    require(report_row and report_row.get("attendeeCount") == 7, f"report did not use stored attendee count: {report_row}")
    require(report_row.get("checkInOutcome") is None, f"untracked booking fabricated a check-in outcome: {report_row}")
    unknown_report_row = next((row for row in report.get("exportRows", []) if row.get("bookingId") == unknown_attendance_id), None)
    require(unknown_report_row and unknown_report_row.get("attendeeCount") is None, f"missing attendance was reported as zero: {unknown_report_row}")
    require(unknown_report_row.get("checkInOutcome") is None, f"unknown booking fabricated a check-in outcome: {unknown_report_row}")
    room_row = next((row for row in report.get("roomUsage", []) if row.get("roomId") == room_id), None)
    require(room_row and room_row.get("averageAttendees") == 7, f"room attendance average is wrong: {room_row}")
    require("attendeeTotal" not in room_row and "attendeeBookings" not in room_row,
            f"report exposed internal room accumulators: {room_row}")

    user_email = f"lifecycle-{stamp}@example.com"
    user_password = "LifecycleQA123!"
    status, created_user = request("POST", f"{base}/api/admin/users", {
        "email": user_email, "password": user_password, "name": "Lifecycle QA User",
        "department": "Lifecycle QA", "role": "user",
    }, admin_token)
    require(status == 201, f"user creation failed: {status} {created_user}")
    status, user_login = request("POST", f"{base}/api/auth/login", {"email": user_email, "password": user_password})
    require(status == 200 and user_login.get("token"), f"user login failed: {status} {user_login}")
    user_token = user_login["token"]

    status, concurrency_room = request("POST", f"{base}/api/admin/rooms", {
        "name": f"Concurrency Room {stamp}", "building": building_name, "floor": 1, "capacity": 20,
        "equipment": [], "requires_approval": 0, "business_hours": {"days": hours}, "buffer_minutes": 0,
    }, admin_token)
    require(status == 201, f"concurrency room failed: {status} {concurrency_room}")
    concurrent_start = now + dt.timedelta(hours=6)
    concurrent_payloads = [{
        "room_id": concurrency_room["id"], "title": f"Concurrent booking {index}",
        "start_time": iso(concurrent_start), "end_time": iso(concurrent_start + dt.timedelta(minutes=30)),
    } for index in range(2)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        concurrent_results = list(executor.map(
            lambda payload: request("POST", f"{base}/api/bookings", payload, admin_token),
            concurrent_payloads,
        ))
    require(any(status == 201 for status, _ in concurrent_results), f"concurrent booking winner missing: {concurrent_results}")
    require(sum(1 for status, _ in concurrent_results if status == 201) == 1, f"overlapping concurrent bookings both succeeded: {concurrent_results}")
    status, concurrent_rows = request("GET", f"{base}/api/bookings?room_id={concurrency_room['id']}", token=admin_token)
    concurrent_created = [row for row in concurrent_rows if row.get("title", "").startswith("Concurrent booking")]
    require(status == 200 and len(concurrent_created) == 1, f"concurrent booking invariant failed: {concurrent_created}")

    race_start = now + dt.timedelta(hours=7)
    booking_race_payload = {
        "room_id": concurrency_room["id"], "title": "Booking-maintenance race",
        "start_time": iso(race_start), "end_time": iso(race_start + dt.timedelta(minutes=30)),
    }
    maintenance_race_payload = {
        "room_id": concurrency_room["id"], "start_time": iso(race_start),
        "end_time": iso(race_start + dt.timedelta(minutes=30)), "reason": "Concurrency regression",
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        booking_future = executor.submit(request, "POST", f"{base}/api/bookings", booking_race_payload, admin_token)
        maintenance_future = executor.submit(request, "POST", f"{base}/api/admin/maintenance", maintenance_race_payload, admin_token)
        booking_maintenance_results = [booking_future.result(), maintenance_future.result()]
    require(sum(1 for status, _ in booking_maintenance_results if status == 201) == 1,
            f"booking and maintenance race did not preserve exclusivity: {booking_maintenance_results}")

    status, shared_calendar = request("GET", f"{base}/api/bookings?room_id={room_id}", token=user_token)
    require(status == 200, f"shared calendar fetch failed: {status} {shared_calendar}")
    private_booking = next((row for row in shared_calendar if row.get("id") == booking_id), None)
    require(private_booking and private_booking.get("can_view_private") == 0, f"foreign booking privacy marker is wrong: {private_booking}")
    for private_field in ("organizer_email", "attendees", "attendee_count", "equipment", "notes", "custom_fields", "cancellation_reason", "checked_in"):
        require(private_booking.get(private_field) is None, f"foreign booking exposed {private_field}: {private_booking}")

    approval_room_hours = {str(day): {"enabled": True, "start": "00:00", "end": "00:01"} for day in range(7)}
    status, approval_room = request("POST", f"{base}/api/admin/rooms", {
        "name": f"Approval Room {stamp}", "building": building_name, "floor": 1, "capacity": 20,
        "equipment": [], "requires_approval": 1, "business_hours": {"days": approval_room_hours}, "buffer_minutes": 0,
    }, admin_token)
    require(status == 201, f"approval room failed: {status} {approval_room}")
    approval_start = now + dt.timedelta(hours=4)
    status, pending_booking = request("POST", f"{base}/api/bookings", {
        "room_id": approval_room["id"], "title": f"Approval safety QA {stamp}",
        "start_time": iso(approval_start), "end_time": iso(approval_start + dt.timedelta(minutes=30)),
        "notes": "approval link must not expose or mutate on GET",
    }, user_token)
    require(status == 201 and pending_booking.get("status") == "pending", f"pending booking setup failed: {status} {pending_booking}")
    approve_token = approval_token(pending_booking["id"], "approve", args.jwt_secret)
    approval_url = f"{base}/api/approvals/{approve_token}/approve"
    status, confirmation = request("GET", approval_url)
    require(status == 200 and confirmation.get("requires_confirmation") is True, f"approval GET did not require confirmation: {status} {confirmation}")
    status, still_pending = request("GET", f"{base}/api/bookings?room_id={approval_room['id']}", token=admin_token)
    pending_after_get = next((row for row in still_pending if row.get("id") == pending_booking["id"]), None)
    require(pending_after_get and pending_after_get.get("status") == "pending", f"approval GET mutated booking: {pending_after_get}")
    status, approved = request("POST", approval_url)
    require(status == 200 and approved.get("booking", {}).get("status") == "confirmed", f"approval POST failed: {status} {approved}")
    approval_date = approval_start.astimezone(timezone).date().isoformat()
    approval_report_query = urllib.parse.urlencode({"start_date": approval_date, "end_date": approval_date, "room_id": approval_room["id"]})
    status, approval_report = request("GET", f"{base}/api/admin/analytics?{approval_report_query}", token=admin_token)
    approval_report_row = next((row for row in approval_report.get("exportRows", []) if row.get("bookingId") == pending_booking["id"]), None)
    require(status == 200 and approval_report_row and approval_report_row.get("department") == "Lifecycle QA",
            f"report did not preserve booking-time department: {status} {approval_report_row}")

    status, self_deactivate = request("PATCH", f"{base}/api/admin/users/{login['user']['id']}", {"is_active": 0}, admin_token)
    require(status == 400, f"admin could deactivate own account: {status} {self_deactivate}")

    status, denied = request("POST", f"{base}/api/bookings/{booking_id}/check-in", token=user_token)
    require(status == 403, f"unrelated user could check in: {status} {denied}")
    status, checked_in = request("POST", f"{base}/api/bookings/{booking_id}/check-in", token=admin_token)
    require(status == 200 and checked_in.get("check_in", {}).get("booking_id") == booking_id, f"check-in failed: {status} {checked_in}")
    status, duplicate = request("POST", f"{base}/api/bookings/{booking_id}/check-in", token=admin_token)
    require(status == 409, f"duplicate check-in was accepted: {status} {duplicate}")
    status, tracked_report = request("GET", f"{base}/api/admin/analytics?{query}", token=admin_token)
    tracked_summary = tracked_report.get("summary", {}) if isinstance(tracked_report, dict) else {}
    require(status == 200 and tracked_summary.get("checkInTrackedCount") == 1
            and tracked_summary.get("checkedInCount") == 1 and tracked_summary.get("checkInRate") == 100
            and tracked_summary.get("noShowRate") == 0,
            f"persisted check-in outcome was not reported correctly: {status} {tracked_summary}")
    tracked_row = next((row for row in tracked_report.get("exportRows", []) if row.get("bookingId") == booking_id), None)
    require(tracked_row and tracked_row.get("checkInOutcome") == "checked_in",
            f"export did not expose the persisted check-in outcome: {tracked_row}")

    status, bookings = request("GET", f"{base}/api/bookings?room_id={room_id}", token=admin_token)
    require(status == 200, f"booking fetch failed: {status} {bookings}")
    fetched = next((row for row in bookings if row.get("id") == booking_id), None)
    require(fetched and fetched.get("checked_in") == 1, f"booking does not expose check-in state: {fetched}")

    status, updated = request("PATCH", f"{base}/api/bookings/{booking_id}", {
        "attendee_count": 3, "notes": "", "custom_fields": {},
    }, admin_token)
    require(status == 200, f"booking update failed: {status} {updated}")
    require(updated.get("attendee_count") == 3, f"attendee update failed: {updated}")
    require(updated.get("notes") == "", f"notes could not be cleared: {updated}")
    require(updated.get("custom_fields") == "{}", f"custom fields could not be cleared: {updated}")

    future_start = now + dt.timedelta(hours=1)
    future_end = future_start + dt.timedelta(minutes=30)
    status, future_booking = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Future check-in QA", "start_time": iso(future_start), "end_time": iso(future_end),
    }, admin_token)
    require(status == 201, f"future booking failed: {status} {future_booking}")
    status, future_default_report = request("GET", f"{base}/api/admin/analytics", token=admin_token)
    future_default_ids = {row.get("bookingId") for row in future_default_report.get("exportRows", [])} if isinstance(future_default_report, dict) else set()
    require(status == 200 and future_booking["id"] in future_default_ids,
            f"new future booking was missing from the default report: {status} {future_default_report.get('range') if isinstance(future_default_report, dict) else future_default_report}")
    status, too_early = request("POST", f"{base}/api/bookings/{future_booking['id']}/check-in", token=admin_token)
    require(status == 400 and "opens" in too_early.get("error", "").lower(), f"early check-in accepted: {status} {too_early}")

    status, overlap_maintenance = request("POST", f"{base}/api/admin/maintenance", {
        "room_id": room_id, "start_time": iso(future_start + dt.timedelta(minutes=5)),
        "end_time": iso(future_end - dt.timedelta(minutes=5)), "reason": "Lifecycle overlap test",
    }, admin_token)
    require(status == 409, f"maintenance overlap was accepted: {status} {overlap_maintenance}")

    status, active_building_disabled = request("PATCH", f"{base}/api/admin/buildings/{building['id']}", {"is_active": 0}, admin_token)
    require(status == 409, f"building with active bookings was deactivated: {status} {active_building_disabled}")
    inactive_building_name = f"Inactive Building QA {stamp}"
    status, inactive_building = request("POST", f"{base}/api/admin/buildings", {
        "name": inactive_building_name, "business_hours": {"days": hours},
    }, admin_token)
    require(status == 201, f"inactive test building creation failed: {status} {inactive_building}")
    status, inactive_room = request("POST", f"{base}/api/admin/rooms", {
        "name": f"Inactive Room {stamp}", "building": inactive_building_name, "floor": 1, "capacity": 8,
        "equipment": [], "requires_approval": 0, "business_hours": {"days": hours}, "buffer_minutes": 0,
    }, admin_token)
    require(status == 201, f"inactive test room creation failed: {status} {inactive_room}")
    status, building_disabled = request("PATCH", f"{base}/api/admin/buildings/{inactive_building['id']}", {"is_active": 0}, admin_token)
    require(status == 200, f"empty building deactivation failed: {status} {building_disabled}")
    status, public_rooms = request("GET", f"{base}/api/rooms", token=admin_token)
    require(status == 200 and all(row.get("id") != inactive_room["id"] for row in public_rooms), "inactive building room remains publicly bookable")
    inactive_start = now + dt.timedelta(hours=3)
    status, inactive_booking = request("POST", f"{base}/api/bookings", {
        "room_id": inactive_room["id"], "title": "Inactive building QA", "start_time": iso(inactive_start),
        "end_time": iso(inactive_start + dt.timedelta(minutes=30)),
    }, admin_token)
    require(status == 409, f"booking in inactive building was accepted: {status} {inactive_booking}")

    holiday_target = dt.datetime.now(timezone).date() + dt.timedelta(days=20)
    previous_year = holiday_target.replace(year=holiday_target.year - 1)
    status, holiday = request("POST", f"{base}/api/admin/holidays", {
        "name": f"Recurring QA {stamp}", "date": previous_year.isoformat(), "is_recurring": True,
    }, admin_token)
    require(status == 201, f"recurring holiday creation failed: {status} {holiday}")
    holiday_start = dt.datetime.combine(holiday_target, dt.time(14, 0), timezone)
    status, holiday_booking = request("POST", f"{base}/api/bookings", {
        "room_id": room_id, "title": "Recurring holiday QA", "start_time": iso(holiday_start),
        "end_time": iso(holiday_start + dt.timedelta(minutes=30)),
    }, admin_token)
    require(status == 400 and "holiday" in holiday_booking.get("error", "").lower(), f"recurring holiday was ignored: {status} {holiday_booking}")

    reset_password = "LifecycleReset123!"
    status, reset_user = request("POST", f"{base}/api/admin/users/{created_user['id']}/reset-password", {
        "password": reset_password,
    }, admin_token)
    require(status == 200, f"password reset setup failed: {status} {reset_user}")
    status, forced_reset = request("GET", f"{base}/api/rooms", token=user_token)
    require(status == 401, f"admin reset did not revoke the existing session: {status} {forced_reset}")
    status, reset_login = request("POST", f"{base}/api/auth/login", {"email": user_email, "password": reset_password})
    require(status == 200 and reset_login.get("token"), f"temporary-password login failed: {status} {reset_login}")
    reset_token = reset_login["token"]
    status, forced_reset = request("GET", f"{base}/api/rooms", token=reset_token)
    require(status == 403 and forced_reset.get("code") == "PASSWORD_RESET_REQUIRED", f"forced reset was not enforced by API: {status} {forced_reset}")
    status, changed_password = request("PATCH", f"{base}/api/auth/password", {
        "currentPassword": reset_password, "newPassword": "LifecycleFinal123!",
    }, reset_token)
    require(status == 200 and changed_password.get("token") and not changed_password.get("user", {}).get("must_reset_password"), f"forced password change failed: {status} {changed_password}")
    status, revoked_session = request("GET", f"{base}/api/auth/me", token=reset_token)
    require(status == 401, f"pre-change session was not revoked: {status} {revoked_session}")
    status, renewed_session = request("GET", f"{base}/api/auth/me", token=changed_password["token"])
    require(status == 200, f"replacement session is invalid: {status} {renewed_session}")

    status, active_retire = request("DELETE", f"{base}/api/admin/rooms/{room_id}", token=admin_token)
    require(status == 409, f"room with active bookings was retired: {status} {active_retire}")
    for active_booking_id in (booking_id, unknown_attendance_id, future_booking["id"]):
        status, cancelled = request("POST", f"{base}/api/bookings/{active_booking_id}/cancel", {
            "reason": "Lifecycle retirement QA",
        }, admin_token)
        require(status == 200, f"booking cancellation before retirement failed: {status} {cancelled}")
    status, retired = request("DELETE", f"{base}/api/admin/rooms/{room_id}", token=admin_token)
    require(status == 200 and retired.get("retired") is True, f"room with history was hard-deleted or not retired: {status} {retired}")
    status, preserved = request("GET", f"{base}/api/bookings?room_id={room_id}", token=admin_token)
    require(status == 200 and any(row.get("id") == booking_id for row in preserved), "room retirement destroyed booking history")

    print("Booking lifecycle API regression checks passed")


if __name__ == "__main__":
    main()
