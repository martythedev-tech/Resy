import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authenticate, authorize } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { diagnosticsController } from '../controllers/diagnostics.controller';
import { retentionController } from '../controllers/retention.controller';
import { withBookingMutationLock } from '../middleware/bookingMutation';

const router = Router();

router.use(authenticate);

// Reporting is read-only and available to explicitly assigned report viewers.
router.get('/analytics', authorize('admin', 'room_manager', 'report_viewer'), adminController.getAnalytics);

router.use(authorize('admin', 'room_manager'));

// Holidays
router.get('/holidays', adminController.getHolidays);
router.post('/holidays', authorize('admin'), adminController.createHoliday);
router.delete('/holidays/:id', authorize('admin'), adminController.deleteHoliday);

// Maintenance
router.get('/maintenance', adminController.getMaintenance);
router.post('/maintenance', authorize('admin'), withBookingMutationLock(adminController.createMaintenance.bind(adminController)));
router.delete('/maintenance/:id', authorize('admin'), adminController.deleteMaintenance);

// Booking Rules
router.get('/rules', adminController.getRules);
router.patch('/rules/:id', authorize('admin'), adminController.updateRule);

// Booking approvals
router.get('/bookings/pending', adminController.getPendingBookings);
router.post('/bookings/:id/approve', authorize('admin', 'room_manager'), withBookingMutationLock(adminController.approveBooking.bind(adminController)));
router.post('/bookings/:id/reject', authorize('admin', 'room_manager'), withBookingMutationLock(adminController.rejectBooking.bind(adminController)));

// Building Management
router.get('/buildings', adminController.getBuildings);
router.post('/buildings', authorize('admin'), adminController.createBuilding);
router.patch('/buildings/:id', authorize('admin', 'room_manager'), withBookingMutationLock(adminController.updateBuilding.bind(adminController)));
router.delete('/buildings/:id', authorize('admin'), withBookingMutationLock(adminController.deleteBuilding.bind(adminController)));
router.post('/buildings/:id/image', authorize('admin'), upload.single('image'), adminController.uploadBuildingImage);

// Room Management
router.get('/rooms', adminController.getRooms);
router.post('/rooms', authorize('admin'), adminController.createRoom);
router.patch('/rooms/:id', authorize('admin', 'room_manager'), withBookingMutationLock(adminController.updateRoom.bind(adminController)));
router.delete('/rooms/:id', authorize('admin'), withBookingMutationLock(adminController.deleteRoom.bind(adminController)));
router.post('/rooms/:id/image', authorize('admin'), upload.single('image'), adminController.uploadRoomImage);

// Webhooks (admin only - sensitive integration config)
router.get('/webhook-policy', authorize('admin'), adminController.getWebhookPolicy);
router.put('/webhook-policy', authorize('admin'), adminController.updateWebhookPolicy);
router.get('/webhooks', authorize('admin'), adminController.getWebhooks);
router.post('/webhooks', authorize('admin'), adminController.createWebhook);
router.patch('/webhooks/:id', authorize('admin'), adminController.updateWebhook);
router.delete('/webhooks/:id', authorize('admin'), adminController.deleteWebhook);

// Email configuration (admin only - contains SMTP credentials)
router.get('/email-config', authorize('admin'), adminController.getEmailConfig);
router.put('/email-config', authorize('admin'), adminController.updateEmailConfig);
router.post('/email-config/test', authorize('admin'), adminController.testEmail);

// Site branding configuration (admin only for write)
router.get('/site-config', adminController.getSiteConfig);
router.put('/site-config', authorize('admin'), adminController.updateSiteConfig);
router.post('/site-config/logo', authorize('admin'), upload.single('logo'), adminController.uploadLogo);
router.post('/site-config/favicon', authorize('admin'), upload.single('favicon'), adminController.uploadFavicon);

// Directory integration status/testing (admin only)
router.get('/directory/status', authorize('admin'), adminController.getDirectoryStatus);
router.put('/directory/config', authorize('admin'), adminController.updateDirectoryConfig);
router.delete('/directory/config', authorize('admin'), adminController.resetDirectoryConfig);
router.post('/directory/test', authorize('admin'), adminController.testDirectoryConnection);

// Sanitized operational diagnostics (full administrators only)
router.get('/diagnostics', authorize('admin'), diagnosticsController.list);
router.get('/diagnostics/summary', authorize('admin'), diagnosticsController.summary);

// Booking data retention (full administrators only)
router.get('/retention', authorize('admin'), retentionController.getSummary.bind(retentionController));
router.put('/retention', authorize('admin'), retentionController.updateConfig.bind(retentionController));
router.post('/retention/run', authorize('admin'), retentionController.run.bind(retentionController));
router.get('/retention/bookings', authorize('admin'), retentionController.searchBookings.bind(retentionController));
router.patch('/bookings/:id/retention-hold', authorize('admin'), retentionController.setHold.bind(retentionController));

// User Management (admin only)
router.get('/users', authorize('admin'), adminController.getUsers);
router.post('/users', authorize('admin'), adminController.createUser);
router.patch('/users/:id', authorize('admin'), adminController.updateUser);
router.post('/users/:id/reset-password', authorize('admin'), adminController.resetUserPassword);
router.delete('/users/:id', authorize('admin'), adminController.deleteUser);

export default router;
