import { Router } from 'express';
import { roomsController } from '../controllers/rooms.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', roomsController.getAll);
router.get('/:id', roomsController.getById);
router.get('/:id/availability', roomsController.getAvailability);

export default router;
