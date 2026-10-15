import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { bookingRetentionService } from '../services/bookingRetention.service';

export class RetentionController {
  getSummary(req: AuthRequest, res: Response) {
    try {
      res.json(bookingRetentionService.preview());
    } catch (error) {
      console.error('Get retention summary error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  updateConfig(req: AuthRequest, res: Response) {
    try {
      const retentionMonths = Number(req.body.retention_months);
      const backupDays = Number(req.body.backup_retention_days);
      const enabled = req.body.enabled === true || req.body.enabled === 1;
      if (!Number.isInteger(retentionMonths) || retentionMonths < 1 || retentionMonths > 120) {
        return res.status(400).json({ error: 'Retention period must be between 1 and 120 months' });
      }
      if (!Number.isInteger(backupDays) || backupDays < 1 || backupDays > 3650) {
        return res.status(400).json({ error: 'Backup retention must be between 1 and 3650 days' });
      }
      if (enabled && req.body.confirm_backups !== true) {
        return res.status(400).json({ error: 'Confirm that a current backup exists before enabling automatic anonymization' });
      }
      bookingRetentionService.updateConfig({
        retention_months: retentionMonths,
        enabled,
        backup_retention_days: backupDays,
      });
      res.json(bookingRetentionService.preview());
    } catch (error) {
      console.error('Update retention config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  run(req: AuthRequest, res: Response) {
    try {
      if (req.body.confirm !== true) {
        return res.status(400).json({ error: 'Explicit confirmation is required' });
      }
      const result = bookingRetentionService.runBatch(500, 'manual');
      res.json({ ...result, preview: bookingRetentionService.preview() });
    } catch (error) {
      console.error('Run retention error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  setHold(req: AuthRequest, res: Response) {
    try {
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId < 1 || typeof req.body.hold !== 'boolean') {
        return res.status(400).json({ error: 'Valid booking id and hold value are required' });
      }
      const result = bookingRetentionService.setHold(bookingId, req.body.hold);
      if (!result) return res.status(404).json({ error: 'Booking not found or already anonymized' });
      res.json(result);
    } catch (error) {
      console.error('Set retention hold error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  searchBookings(req: AuthRequest, res: Response) {
    try {
      const query = String(req.query.q || '').trim();
      if (!query) return res.json([]);
      if (query.length > 120) return res.status(400).json({ error: 'Search must be 120 characters or fewer' });
      res.json(bookingRetentionService.searchBookings(query));
    } catch (error) {
      console.error('Search retention bookings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const retentionController = new RetentionController();
