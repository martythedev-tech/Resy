import { Request, Response } from 'express';
import { pool } from '../config/database';
import { verifyApprovalToken } from '../services/approvalToken.service';
import { emailService } from '../services/email.service';
import { webhookService } from '../services/webhook.service';
import { bookingRulesService } from '../services/bookingRules.service';

const escapeHtml = (value: unknown): string => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

class ApprovalController {
  private confirmationPage(
    res: Response,
    action: 'approve' | 'reject',
    token: string,
    booking: any,
  ) {
    const isApproval = action === 'approve';
    const verb = isApproval ? 'Approve' : 'Reject';
    const safeDetail = escapeHtml(`${booking.room_name || `Room ${booking.room_id}`}: ${booking.title}`);
    const safeAction = escapeHtml(`/api/approvals/${encodeURIComponent(token)}/${action}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${verb} booking</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8fafc; color:#0f172a; padding:40px; }
    .card { max-width:560px; margin:0 auto; background:#fff; border-radius:16px; padding:28px 30px; box-shadow:0 12px 30px rgba(15,23,42,.12); }
    h1 { font-size:22px; margin:0 0 12px; }
    p { margin:0 0 14px; color:#475569; }
    .detail { margin:16px 0 22px; padding:14px; border-radius:10px; background:#f1f5f9; font-weight:600; }
    button { border:0; border-radius:10px; padding:12px 18px; color:#fff; background:${isApproval ? '#15803d' : '#b91c1c'}; font:inherit; font-weight:700; cursor:pointer; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${verb} this booking?</h1>
    <p>Review the booking below, then confirm your decision. Opening this page does not change the booking.</p>
    <div class="detail">${safeDetail}</div>
    <form method="post" action="${safeAction}">
      <button type="submit">Confirm ${verb.toLowerCase()}</button>
    </form>
  </main>
</body>
</html>`);
  }

  private respond(req: Request, res: Response, status: number, message: string, booking?: any) {
    const wantsHtml = req.accepts(['html', 'json']) === 'html';
    if (wantsHtml) {
      const title = status >= 400 ? 'Approval Error' : 'Approval Updated';
      const detail = booking
        ? `${booking.room_name || `Room ${booking.room_id}`}: ${booking.title}`
        : '';
      const safeTitle = escapeHtml(title);
      const safeMessage = escapeHtml(message);
      const safeDetail = escapeHtml(detail);
      res.status(status).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8fafc; color:#0f172a; padding:40px; }
    .card { max-width:560px; margin:0 auto; background:#fff; border-radius:16px; padding:28px 30px; box-shadow:0 12px 30px rgba(15, 23, 42, 0.12); }
    h1 { font-size:22px; margin:0 0 12px; }
    p { margin:0 0 10px; color:#475569; }
    .detail { margin-top:12px; font-weight:600; color:#0f172a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${safeDetail ? `<div class="detail">${safeDetail}</div>` : ''}
  </div>
</body>
</html>`);
      return;
    }
    res.status(status).json({ message, booking });
  }

  private async loadBooking(bookingId: number) {
    const result = await pool.query(
      `SELECT b.*, r.name as room_name, r.building as room_building, r.floor as room_floor,
              u.email as organizer_email, u.role as organizer_role
       FROM bookings b
       LEFT JOIN rooms r ON b.room_id = r.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE b.id = $1`,
      [bookingId]
    );
    return result.rows[0] as any | undefined;
  }

  private buildPayload(event: 'booking_updated' | 'booking_cancelled', booking: any, changes?: Record<string, { from: any; to: any }>) {
    return {
      event,
      booking_id: booking.id,
      room_id: booking.room_id,
      title: booking.title,
      room: booking.room_name || `Room ${booking.room_id}`,
      building: booking.room_building || undefined,
      floor: booking.room_floor ?? undefined,
      organizer: booking.organizer_email || 'unknown',
      startTime: new Date(booking.start_time).toISOString(),
      endTime: new Date(booking.end_time).toISOString(),
      status: booking.status,
      durationMinutes: Math.max(0, Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 60000)),
      changes,
      reason: booking.cancellation_reason || undefined,
    } as const;
  }

  private async confirmFromToken(req: Request, res: Response, action: 'approve' | 'reject') {
    const token = req.params.token;
    const verified = verifyApprovalToken(token);
    if (!verified || verified.action !== action) {
      return this.respond(req, res, 400, `This ${action === 'approve' ? 'approval' : 'rejection'} link is invalid or has expired.`);
    }

    const booking = await this.loadBooking(verified.bookingId) as any;
    if (!booking) return this.respond(req, res, 404, 'Booking not found.');
    if (booking.status !== 'pending') {
      const message = booking.status === 'confirmed'
        ? 'This booking was already approved.'
        : booking.status === 'cancelled'
          ? 'This booking was already cancelled.'
          : `This booking cannot be changed from its current status (${booking.status}).`;
      return this.respond(req, res, booking.status === 'confirmed' ? 200 : 409, message, booking);
    }

    if (req.accepts(['html', 'json']) === 'html') {
      return this.confirmationPage(res, action, token, booking);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      message: `Confirmation required before this booking is ${action === 'approve' ? 'approved' : 'rejected'}.`,
      action,
      requires_confirmation: true,
      booking: {
        id: booking.id,
        title: booking.title,
        room_name: booking.room_name,
        start_time: booking.start_time,
        end_time: booking.end_time,
        status: booking.status,
      },
    });
  }

  async confirmApproval(req: Request, res: Response) {
    return this.confirmFromToken(req, res, 'approve');
  }

  async confirmRejection(req: Request, res: Response) {
    return this.confirmFromToken(req, res, 'reject');
  }

  async approveFromToken(req: Request, res: Response) {
    const token = req.params.token;
    const verified = verifyApprovalToken(token);
    if (!verified || verified.action !== 'approve') {
      return this.respond(req, res, 400, 'This approval link is invalid or has expired.');
    }

    const booking = await this.loadBooking(verified.bookingId) as any;
    if (!booking) return this.respond(req, res, 404, 'Booking not found.');

    if (booking.status === 'confirmed') {
      return this.respond(req, res, 200, 'This booking was already approved.', booking);
    }
    if (booking.status === 'cancelled') {
      return this.respond(req, res, 409, 'This booking was already cancelled.', booking);
    }
    if (booking.status !== 'pending') {
      return this.respond(req, res, 409, `This booking cannot be approved from its current status (${booking.status}).`, booking);
    }

    const violations = await bookingRulesService.validateBooking(
      new Date(booking.start_time),
      new Date(booking.end_time),
      Number(booking.user_id),
      Number(booking.room_id),
      booking.organizer_role || 'user',
      Number(booking.id),
      { skipBusinessHours: true },
    );
    if (violations.length > 0) {
      return this.respond(req, res, 409, `This booking can no longer be approved: ${violations[0].message}`, booking);
    }

    const result = await pool.query(
      `UPDATE bookings
       SET status = 'confirmed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [booking.id]
    );
    if (result.rows.length === 0) {
      return this.respond(req, res, 409, 'The booking status changed before it could be approved.', booking);
    }

    const updated = Object.assign({}, booking, result.rows[0] as any, { status: 'confirmed' });
    const payload = this.buildPayload('booking_updated', updated, { status: { from: booking.status, to: 'confirmed' } });

    webhookService.send(payload);
    emailService.send(payload);
    emailService.notifyRoomManagers(payload);

    return this.respond(req, res, 200, 'Booking approved successfully.', updated);
  }

  async rejectFromToken(req: Request, res: Response) {
    const token = req.params.token;
    const verified = verifyApprovalToken(token);
    if (!verified || verified.action !== 'reject') {
      return this.respond(req, res, 400, 'This rejection link is invalid or has expired.');
    }

    const booking = await this.loadBooking(verified.bookingId) as any;
    if (!booking) return this.respond(req, res, 404, 'Booking not found.');

    if (booking.status === 'cancelled') {
      return this.respond(req, res, 200, 'This booking was already rejected.', booking);
    }
    if (booking.status === 'confirmed') {
      return this.respond(req, res, 409, 'This booking was already approved and can no longer be rejected.', booking);
    }
    if (booking.status !== 'pending') {
      return this.respond(req, res, 409, `This booking cannot be rejected from its current status (${booking.status}).`, booking);
    }

    const reason = 'Rejected via approval link';
    const result = await pool.query(
      `UPDATE bookings
       SET status = 'cancelled',
           cancellation_reason = $1,
           cancelled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [reason, booking.id]
    );
    if (result.rows.length === 0) {
      return this.respond(req, res, 409, 'The booking status changed before it could be rejected.', booking);
    }

    const updated = Object.assign({}, booking, result.rows[0] as any, { status: 'cancelled', cancellation_reason: reason });
    const payload = this.buildPayload('booking_cancelled', updated, { status: { from: booking.status, to: 'cancelled' } });

    webhookService.send(payload);
    emailService.send(payload);
    emailService.notifyRoomManagers(payload);

    return this.respond(req, res, 200, 'Booking rejected successfully.', updated);
  }
}

export const approvalController = new ApprovalController();
