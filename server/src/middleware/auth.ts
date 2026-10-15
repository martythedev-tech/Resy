import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    role: string;
    must_reset_password?: number;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;

    // Check if user still exists and is active
    const result = await pool.query(
      'SELECT id, email, role, is_active, must_reset_password, token_version FROM users WHERE id = $1',
      [decoded.userId]
    );

    const user = result.rows[0] as any;

    if (result.rows.length === 0 || !user.is_active) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Tokens issued before token versioning are treated as version zero. Any
    // password reset/change increments the stored version and revokes them.
    if (Number(decoded.tokenVersion ?? 0) !== Number(user.token_version || 0)) {
      return res.status(401).json({ error: 'Session has been revoked' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      must_reset_password: Number(user.must_reset_password || 0),
    };

    const isPasswordRecoveryRoute = req.baseUrl === '/api/auth'
      && (req.path === '/password' || req.path === '/me');
    if (req.user.must_reset_password && !isPasswordRecoveryRoute) {
      return res.status(403).json({ error: 'Password reset required', code: 'PASSWORD_RESET_REQUIRED' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};
