import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { pool } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { directoryAuthService, DirectoryIdentity } from '../services/directoryAuth.service';
import { recordOperationalWarning } from '../services/diagnostics.service';

export class AuthController {
  private recordRejectedSignIn(
    req: Request,
    res: Response,
    category: 'login_rejected' | 'login_blocked' | 'configuration',
    message: string,
    statusCode: number,
    authenticationMode: 'directory' | 'local' | 'directory_with_local_fallback',
    reason: string,
  ) {
    recordOperationalWarning({
      source: 'authentication',
      category,
      message,
      requestId: res.locals.requestId || null,
      method: req.method,
      path: req.path,
      statusCode,
      metadata: { authentication_mode: authenticationMode, reason },
    });
  }

  private signToken(user: { id: number; email: string; role: string; token_version?: number }): string {
    return jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tokenVersion: Number(user.token_version || 0) },
      process.env.JWT_SECRET as string,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as any
    );
  }

  private buildAuthPayload(user: any, token: string) {
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        department: user.department,
        must_reset_password: user.must_reset_password || 0,
      },
    };
  }

  private async authenticateLocal(normalizedEmail: string, password: string) {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = 1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0] as any;
    if (user.suspension_until && new Date(user.suspension_until) > new Date()) {
      return { suspended: true, suspendedUntil: user.suspension_until };
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return null;
    }

    return { user };
  }

  private async upsertDirectoryUser(identity: DirectoryIdentity): Promise<any> {
    const config = directoryAuthService.getConfig();
    const lookup = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [identity.email]
    );

    if (lookup.rows.length === 0) {
      const randomPasswordHash = await bcrypt.hash(randomUUID(), 12);
      const created = await pool.query(
        `INSERT INTO users (email, password_hash, name, department, role, directory_role_locked, must_reset_password, is_active)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 1)
         RETURNING *`,
        [identity.email, randomPasswordHash, identity.name, identity.department, identity.role]
      );
      return created.rows[0] as any;
    }

    const existing = lookup.rows[0] as any;
    const nextName = config.syncProfile ? identity.name : existing.name;
    const nextDepartment = config.syncProfile ? identity.department : existing.department;
    const nextRole = config.syncRoles && !existing.directory_role_locked ? identity.role : existing.role;
    const updated = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           department = $2,
           role = COALESCE($3, role),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [nextName, nextDepartment, nextRole, existing.id]
    );
    return updated.rows[0] as any;
  }

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const normalizedEmail = String(email).toLowerCase().trim();
      const normalizedPassword = String(password);

      // Optional first-run bootstrap: if enabled and there are no users yet,
      // first login credentials create an admin account.
      const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
      const existingUsers = Number((userCountResult.rows[0] as any)?.count || 0);
      const firstLoginBootstrapEnabled =
        String(process.env.ENABLE_FIRST_LOGIN_BOOTSTRAP || '').toLowerCase() === 'true';
      if (existingUsers === 0 && firstLoginBootstrapEnabled) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
          return res.status(400).json({ error: 'Invalid email format' });
        }
        if (normalizedPassword.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const passwordHash = await bcrypt.hash(normalizedPassword, 12);
        const bootstrapResult = await pool.query(
          `INSERT INTO users (email, password_hash, name, role, must_reset_password, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, email, name, role, department, must_reset_password, token_version`,
          [normalizedEmail, passwordHash, 'Administrator', 'admin', 0, 1]
        );

        const bootstrapUser = bootstrapResult.rows[0] as any;
        const bootstrapToken = this.signToken(bootstrapUser);

        return res.status(201).json({
          token: bootstrapToken,
          user: {
            id: bootstrapUser.id,
            email: bootstrapUser.email,
            name: bootstrapUser.name,
            role: bootstrapUser.role,
            department: bootstrapUser.department,
            must_reset_password: bootstrapUser.must_reset_password || 0,
          },
        });
      }

      const directoryConfig = directoryAuthService.getConfig();
      const directoryEnabled = directoryConfig.enabled && directoryAuthService.isConfigured(directoryConfig);
      if (directoryEnabled) {
        const directoryIdentity = await directoryAuthService.authenticate(normalizedEmail, normalizedPassword);
        if (directoryIdentity) {
          const user = await this.upsertDirectoryUser(directoryIdentity);

          if (!user.is_active) {
            this.recordRejectedSignIn(req, res, 'login_blocked', 'Sign-in blocked for an inactive account', 403, 'directory', 'inactive');
            return res.status(403).json({ error: 'Account is inactive' });
          }
          if (user.suspension_until && new Date(user.suspension_until) > new Date()) {
            this.recordRejectedSignIn(req, res, 'login_blocked', 'Sign-in blocked for a suspended account', 403, 'directory', 'suspended');
            return res.status(403).json({
              error: 'Account suspended',
              suspendedUntil: user.suspension_until,
            });
          }

          const token = this.signToken(user);
          return res.json(this.buildAuthPayload(user, token));
        }

        if (!directoryConfig.allowLocalFallback) {
          this.recordRejectedSignIn(req, res, 'login_rejected', 'Sign-in attempt rejected', 401, 'directory', 'invalid_credentials');
          return res.status(401).json({ error: 'Invalid directory credentials' });
        }
      }

      if (existingUsers === 0) {
        this.recordRejectedSignIn(
          req,
          res,
          'configuration',
          'Sign-in blocked because local authentication is not initialized',
          403,
          directoryEnabled ? 'directory_with_local_fallback' : 'local',
          'not_initialized',
        );
        return res.status(403).json({
          error:
            'Local login is not initialized. Configure DEFAULT_ADMIN_* and ENABLE_DEFAULT_ADMIN=true, or enable first-login bootstrap explicitly.',
        });
      }

      const localAuth = await this.authenticateLocal(normalizedEmail, normalizedPassword);
      if (!localAuth) {
        this.recordRejectedSignIn(
          req,
          res,
          'login_rejected',
          'Sign-in attempt rejected',
          401,
          directoryEnabled ? 'directory_with_local_fallback' : 'local',
          'invalid_credentials',
        );
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if ((localAuth as any).suspended) {
        this.recordRejectedSignIn(
          req,
          res,
          'login_blocked',
          'Sign-in blocked for a suspended account',
          403,
          directoryEnabled ? 'directory_with_local_fallback' : 'local',
          'suspended',
        );
        return res.status(403).json({
          error: 'Account suspended',
          suspendedUntil: (localAuth as any).suspendedUntil,
        });
      }

      const user = (localAuth as any).user;
      const token = this.signToken(user);
      res.json(this.buildAuthPayload(user, token));
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async register(req: Request, res: Response) {
    try {
      const allowRegistration = String(process.env.ALLOW_PUBLIC_REGISTRATION || '').toLowerCase() === 'true';
      if (!allowRegistration) {
        return res.status(403).json({ error: 'Public registration is disabled' });
      }
      const { email, password, name, department } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name required' });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Validate password strength (min 8 chars)
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // Validate name length
      if (name.length > 100) {
        return res.status(400).json({ error: 'Name too long (max 100 characters)' });
      }

      // Check if user exists
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
        email.toLowerCase(),
      ]);

      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password (12 rounds for better security)
      const password_hash = await bcrypt.hash(password, 12);

      // Create user
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, name, department, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, name, role, department, must_reset_password, token_version`,
        [email.toLowerCase(), password_hash, name, department || null, 'user']
      );

      const user = result.rows[0] as any;

      // Generate JWT
      const token = this.signToken(user);

      res.status(201).json({ token, user: { ...user, must_reset_password: user.must_reset_password || 0 } });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async me(req: AuthRequest, res: Response) {
    try {
      const result = await pool.query(
        `SELECT id, email, name, role, department, no_show_count, suspension_until, must_reset_password
         FROM users WHERE id = $1`,
        [req.user!.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = result.rows[0] as any;
      res.json({ ...user, must_reset_password: user.must_reset_password || 0 });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async changePassword(req: AuthRequest, res: Response) {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const result = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [
        req.user!.id,
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = result.rows[0] as any;

      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password_hash))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const password_hash = await bcrypt.hash(newPassword, 12);

      const update = await pool.query(
        `UPDATE users
         SET password_hash = $1,
             must_reset_password = 0,
             token_version = token_version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id, email, name, role, department, must_reset_password, token_version`,
        [password_hash, req.user!.id]
      );

      const updatedUser = update.rows[0] as any;
      res.json(this.buildAuthPayload(updatedUser, this.signToken(updatedUser)));
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const authController = new AuthController();
