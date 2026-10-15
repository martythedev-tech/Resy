import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthRequest } from './auth';

let mutationTail: Promise<void> = Promise.resolve();

export const runBookingMutationExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  const previous = mutationTail;
  mutationTail = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

export const withBookingMutationLock = (handler: RequestHandler): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await runBookingMutationExclusive(async () => {
        await Promise.resolve(handler(req, res, next));
      });
    } catch (error) {
      next(error);
    }
  };
};

interface RateBucket {
  startedAt: number;
  count: number;
}

const mutationBuckets = new Map<string, RateBucket>();

export const bookingMutationRateLimit = (maxRequests = 60, windowMs = 15 * 60_000): RequestHandler => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const key = req.user ? `user:${req.user.id}` : `ip:${req.ip}`;
    const now = Date.now();
    const bucket = mutationBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      mutationBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    if (bucket.count >= maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000))));
      return res.status(429).json({ error: 'Too many booking changes. Please try again later.' });
    }
    bucket.count += 1;
    next();
  };
};
