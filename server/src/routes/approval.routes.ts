import { Router } from 'express';
import { approvalController } from '../controllers/approval.controller';
import { withBookingMutationLock } from '../middleware/bookingMutation';

const router = Router();

// GET is intentionally read-only. Email security scanners and link-preview bots
// commonly follow links, so the actual state change requires an explicit POST.
router.get('/:token/approve', approvalController.confirmApproval.bind(approvalController));
router.get('/:token/reject', approvalController.confirmRejection.bind(approvalController));
router.post('/:token/approve', withBookingMutationLock(approvalController.approveFromToken.bind(approvalController)));
router.post('/:token/reject', withBookingMutationLock(approvalController.rejectFromToken.bind(approvalController)));

export default router;
