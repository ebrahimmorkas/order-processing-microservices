import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { Unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string;
}

/**
 * Headers the API gateway sets after verifying the JWT. Internal services
 * trust them because they are only reachable through the gateway, which
 * strips any client-supplied values.
 */
export const USER_ID_HEADER = 'x-user-id';
export const USER_EMAIL_HEADER = 'x-user-email';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser, secret: string, expiresIn = '1d'): string {
  return jwt.sign({ sub: user.id, email: user.email }, secret, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string, secret: string): AuthUser {
  const payload = jwt.verify(token, secret) as { sub: string; email: string };
  return { id: payload.sub, email: payload.email };
}

/** For internal services: requires the user identity forwarded by the gateway. */
export const requireGatewayUser: RequestHandler = (req, _res, next) => {
  const id = req.header(USER_ID_HEADER);
  if (!id) throw Unauthorized('Missing user context');
  req.user = { id, email: req.header(USER_EMAIL_HEADER) ?? '' };
  next();
};
