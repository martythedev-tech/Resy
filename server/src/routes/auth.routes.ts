import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { recordOperationalWarning } from '../services/diagnostics.service';

const router = Router();

// Rate limiting for auth endpoints: 20 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts (raised from 5 for easier testing)
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const rate = (req as any).rateLimit;
    if (!rate || Number(rate.used) === Number(rate.limit) + 1) {
      recordOperationalWarning({
        source: 'authentication',
        category: 'rate_limit',
        message: 'Authentication rate limit triggered',
        requestId: res.locals.requestId || null,
        method: req.method,
        path: req.path,
        statusCode: 429,
      });
    }
    res.status(429).json({ error: 'Too many attempts, please try again later' });
  },
});

router.post('/login', authLimiter, (req, res) => authController.login(req, res));
router.post('/register', authLimiter, (req, res) => authController.register(req, res));
router.get('/me', authenticate, (req, res) => authController.me(req as any, res));
router.patch('/password', authenticate, (req, res) => authController.changePassword(req as any, res));

export default router;
