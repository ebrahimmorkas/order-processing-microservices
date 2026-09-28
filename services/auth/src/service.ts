import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { Schema, type Connection } from 'mongoose';
import { z } from 'zod';
import {
  Conflict,
  createBaseApp,
  createEvent,
  finalizeApp,
  NotFound,
  parse,
  requireGatewayUser,
  signToken,
  Unauthorized,
  type EventBus,
  type Logger,
} from '@ops/common';

export const SERVICE = 'auth';
const BCRYPT_ROUNDS = 12;

export interface AuthServiceDeps {
  connection: Connection;
  bus: EventBus;
  logger: Logger;
  jwtSecret: string;
  jwtTtl?: string;
}

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(2).max(80),
  password: z
    .string()
    .min(8)
    .max(72)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});

export function createAuthService({ connection, bus, logger, jwtSecret, jwtTtl }: AuthServiceDeps) {
  const User = connection.model(
    'User',
    new Schema(
      {
        email: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        passwordHash: { type: String, required: true, select: false },
      },
      { timestamps: true },
    ),
  );

  const toPublic = (user: { id: string; email: string; name: string }) => ({
    id: user.id,
    email: user.email,
    name: user.name,
  });
  const issue = (user: { id: string; email: string }) =>
    signToken({ id: user.id, email: user.email }, jwtSecret, jwtTtl);

  const router = Router();

  router.post('/auth/register', async (req, res) => {
    const input = parse(registerSchema, req.body);
    if (await User.exists({ email: input.email })) {
      throw Conflict('Email is already registered', 'EMAIL_TAKEN');
    }
    let user;
    try {
      user = await User.create({
        email: input.email,
        name: input.name,
        passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw Conflict('Email is already registered', 'EMAIL_TAKEN');
      }
      throw err;
    }

    await bus.publish(
      createEvent(
        'user.registered',
        { userId: user.id, email: user.email, name: user.name },
        { source: SERVICE, correlationId: req.id as string },
      ),
    );
    res.status(201).json({ user: toPublic(user), token: issue(user) });
  });

  router.post('/auth/login', async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = await User.findOne({ email: input.email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw Unauthorized('Invalid email or password');
    }
    res.json({ user: toPublic(user), token: issue(user) });
  });

  router.get('/auth/me', requireGatewayUser, async (req, res) => {
    const user = await User.findById(req.user!.id).catch(() => null);
    if (!user) throw NotFound('User');
    res.json({ user: toPublic(user) });
  });

  router.get('/health', (_req, res) => {
    const up = connection.readyState === 1;
    res.status(up ? 200 : 503).json({ service: SERVICE, status: up ? 'ok' : 'degraded' });
  });

  const app = createBaseApp(logger);
  app.use(router);
  finalizeApp(app, logger);

  return {
    app,
    // The auth service only publishes events.
    start: async () => {},
    stop: async () => {},
  };
}
