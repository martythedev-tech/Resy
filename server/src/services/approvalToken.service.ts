import jwt from 'jsonwebtoken';

const TOKEN_TYPE = 'booking_approval';

export type ApprovalAction = 'approve' | 'reject';

export interface ApprovalTokenPayload {
  type: typeof TOKEN_TYPE;
  bookingId: number;
  action: ApprovalAction;
}

export interface VerifiedApprovalToken {
  bookingId: number;
  action: ApprovalAction;
  expiresAt?: Date;
}

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }
  return secret;
};

export const createApprovalToken = (bookingId: number, action: ApprovalAction) => {
  const payload: ApprovalTokenPayload = { type: TOKEN_TYPE, bookingId, action };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '48h' });
};

export const verifyApprovalToken = (token: string): VerifiedApprovalToken | null => {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as ApprovalTokenPayload & { exp?: number };
    if (!decoded || decoded.type !== TOKEN_TYPE) return null;
    if (!decoded.bookingId || !decoded.action) return null;
    return {
      bookingId: decoded.bookingId,
      action: decoded.action,
      expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : undefined,
    };
  } catch {
    return null;
  }
};
