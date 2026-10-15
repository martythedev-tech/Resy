import { Router } from 'express';
import { bookingsController } from '../controllers/bookings.controller';
import { authenticate } from '../middleware/auth';
import { bookingMutationRateLimit, withBookingMutationLock } from '../middleware/bookingMutation';

const router = Router();

router.use(authenticate);

router.get('/', bookingsController.getAll.bind(bookingsController));
router.get('/my-bookings', bookingsController.getMyBookings.bind(bookingsController));
router.get('/templates', bookingsController.getTemplates.bind(bookingsController));
router.post('/templates', bookingMutationRateLimit(), bookingsController.createTemplate.bind(bookingsController));
router.patch('/templates/:id', bookingMutationRateLimit(), bookingsController.updateTemplate.bind(bookingsController));
router.delete('/templates/:id', bookingsController.deleteTemplate.bind(bookingsController));
router.post('/', bookingMutationRateLimit(), withBookingMutationLock(bookingsController.create.bind(bookingsController)));
router.patch('/:id', bookingMutationRateLimit(), withBookingMutationLock(bookingsController.update.bind(bookingsController)));
router.post('/:id/cancel', bookingMutationRateLimit(), withBookingMutationLock(bookingsController.cancel.bind(bookingsController)));
router.post('/:id/check-in', bookingsController.checkIn.bind(bookingsController));

export default router;
