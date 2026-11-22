import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openRosterDatabase, RosterError } from './database.ts';
import type { EventShift, OrganizerAccount, OrganizerSession } from './event.ts';
import { createLoginThrottle } from './login-throttle.ts';
import { maxPasswordLength } from './password-limits.ts';
import { organizerUsernamePattern, validateNewPassword } from './password-policy.ts';

const sessionLifetime = 8 * 60 * 60;
const volunteerSessionLifetime = 180 * 24 * 60 * 60;
const defaultDatabasePath = resolve(import.meta.dirname, '../data/roster-ready.sqlite');
const defaultDistPath = resolve(import.meta.dirname, '../dist');

type ServerOptions = {
  databasePath?: string;
  distPath?: string;
};

type EventParams = { Params: { eventId: string } };
type ShiftParams = { Params: { eventId: string; shiftId: string } };
type VolunteerParams = { Params: { eventId: string; volunteerId: string } };
type InvitationParams = { Params: { token: string } };

function sessionToken(request: FastifyRequest): string | undefined {
  return request.headers.cookie?.match(/(?:^|;\s*)roster_ready_organizer=([\w-]{43})(?:;|$)/)?.[1];
}

function sessionCookie(request: FastifyRequest, token: string, maxAge: number): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `roster_ready_organizer=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function volunteerCode(request: FastifyRequest): string {
  return request.headers.cookie?.match(/(?:^|;\s*)roster_ready_volunteer=([\w-]{24})(?:;|$)/)?.[1] ?? '';
}

function volunteerCookie(request: FastifyRequest<EventParams>, code: string, maxAge: number): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `roster_ready_volunteer=${code}; Path=/api/join/${request.params.eventId}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 64, { cost: 32768, parallelization: 3, maxmem: 64 * 1024 * 1024 }, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

function organizerCredentials(request: FastifyRequest) {
  const { username, password } = readBody(request);
  return { username: typeof username === 'string' ? username.trim().toLowerCase() : '', password };
}

function readBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RosterError(400, 'Send a JSON object.');
  }
  return body as Record<string, unknown>;
}

function readName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0 || name.length > 120) throw new RosterError(400, 'Enter a name of 1 to 120 characters.');
  return name;
}

function readShiftDetails({ name, capacity, startTime, endTime }: Record<string, unknown>): Omit<EventShift, 'id'> {
  if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RosterError(400, 'Enter a positive whole number for the headcount.');
  }
  if (!isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
    throw new RosterError(400, 'Choose a shift end time after its start time on the event date.');
  }
  return { name: readName(name), capacity, startTime, endTime };
}

function readRosterRevision(request: FastifyRequest): string {
  const { revision } = readBody(request);
  if (typeof revision !== 'string' || revision.length === 0) throw new RosterError(400, 'Review the current roster first.');
  return revision;
}

function readWithdrawalRevision(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') return value;
  return undefined;
}

function readShiftIds(shiftIds: unknown): string[] {
  if (!Array.isArray(shiftIds) || !shiftIds.every((shiftId) => typeof shiftId === 'string')) {
    throw new RosterError(400, 'Select valid shifts for your availability.');
  }
  return shiftIds;
}

function readVolunteerId(volunteerId: unknown): string {
  if (typeof volunteerId !== 'string' || volunteerId.length === 0) throw new RosterError(400, 'Open your response before making changes.');
  return volunteerId;
}

function readDate(date: unknown): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(`${date}T`)) return date;
  }
  throw new RosterError(400, 'Enter a valid event date.');
}

function readCreationRequestId(value: unknown, kind: 'event' | 'shift'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new RosterError(400, `Invalid ${kind} creation request.`);
  }
  return value;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function buildServer({ databasePath = defaultDatabasePath, distPath = defaultDistPath }: ServerOptions = {}) {
  const dummySalt = randomBytes(16).toString('hex');
  const dummyHash = randomBytes(64);
  const sessions = new Map<string, { account: OrganizerAccount; expiresAt: number }>();
  const reserveSignIn = createLoginThrottle();
  const database = openRosterDatabase(databasePath);
  const app = Fastify({ bodyLimit: 64 * 1024 });

  function currentOrganizer(request: FastifyRequest): OrganizerAccount | null {
    const token = sessionToken(request);
    if (token === undefined) return null;
    const session = sessions.get(token);
    if (session === undefined) return null;
    if (session.expiresAt > Date.now()) return session.account;
    sessions.delete(token);
    return null;
  }

  function requireOrganizer(request: FastifyRequest): OrganizerAccount {
    const account = currentOrganizer(request);
    if (!account) throw new RosterError(401, 'Sign in as an organizer.');
    return account;
  }

  function startSession(request: FastifyRequest, reply: FastifyReply, account: OrganizerAccount): OrganizerSession {
    const previous = sessionToken(request);
    if (previous !== undefined) sessions.delete(previous);
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { account, expiresAt: now + sessionLifetime * 1000 });
    reply.header('Set-Cookie', sessionCookie(request, token, sessionLifetime));
    return { account };
  }

  app.addHook('onClose', async () => database.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RosterError) return reply.code(error.statusCode).send({ error: error.message });
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const { statusCode } = error;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({ error: 'Invalid request.' });
      }
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'The server could not complete the request.' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Page not found.' }));

  app.get('/api/organizer/session', async (request) => ({ account: currentOrganizer(request) }));

  app.post('/api/organizer/accounts', async (request, reply) => {
    const { username, password } = organizerCredentials(request);
    if (!organizerUsernamePattern.test(username)) {
      throw new RosterError(400, 'Use 3 to 40 letters, numbers, dots, hyphens or underscores. Start with a letter or number.');
    }
    const normalized = validateNewPassword(password, username);
    const salt = randomBytes(16).toString('hex');
    const hash = (await derivePassword(normalized, salt)).toString('hex');
    const account = database.createOrganizer(username, salt, hash);
    return reply.code(201).send(startSession(request, reply, account));
  });

  app.post('/api/organizer/session', async (request, reply) => {
    const { username, password } = organizerCredentials(request);
    if (!organizerUsernamePattern.test(username) || typeof password !== 'string') {
      throw new RosterError(401, 'The username or password is incorrect.');
    }
    const credentials = database.findOrganizer(username);
    const legacyPassword = credentials?.passwordNfc === 0;
    const submittedPassword = legacyPassword ? password : password.normalize('NFC');
    const length = legacyPassword ? submittedPassword.length : [...submittedPassword].length;
    if (length > maxPasswordLength) throw new RosterError(401, 'The username or password is incorrect.');

    const reservation = reserveSignIn(username, request.ip);
    if ('retryAfter' in reservation) {
      reply.header('Retry-After', reservation.retryAfter);
      throw new RosterError(429, 'Too many sign-in attempts. Try again in a few minutes.');
    }
    let candidate: Buffer;
    try {
      candidate = await derivePassword(submittedPassword, credentials?.salt ?? dummySalt);
    } catch (error) {
      reservation.release();
      throw error;
    }
    const matches = timingSafeEqual(candidate, credentials ? Buffer.from(credentials.hash, 'hex') : dummyHash);
    if (!credentials || !matches) throw new RosterError(401, 'The username or password is incorrect.');
    reservation.release();
    return startSession(request, reply, { id: credentials.id, username: credentials.username });
  });

  app.delete('/api/organizer/session', async (request, reply) => {
    const token = sessionToken(request);
    if (token !== undefined) sessions.delete(token);
    reply.header('Set-Cookie', sessionCookie(request, '', 0));
    return { account: null };
  });

  app.get('/api/events', async (request) => ({ events: database.listEvents(requireOrganizer(request).id) }));

  app.post('/api/events', async (request, reply) => {
    const account = requireOrganizer(request);
    const { name, date, organizerId, requestId } = readBody(request);
    if (organizerId !== account.id) throw new RosterError(409, 'The organizer account changed. Review the current workspace before creating an event.');
    return reply.code(201).send(database.createEvent(account.id, readName(name), readDate(date), readCreationRequestId(requestId, 'event')));
  });

  app.get<EventParams>('/api/events/:eventId', async (request) => database.viewEvent(requireOrganizer(request).id, request.params.eventId));

  app.post<EventParams>('/api/events/:eventId/shifts', async (request, reply) => {
    const account = requireOrganizer(request);
    const { eventId } = request.params;
    const body = readBody(request);
    database.createShift(account.id, eventId, readShiftDetails(body), readCreationRequestId(body.requestId, 'shift'));
    return reply.code(201).send(database.viewEvent(account.id, eventId));
  });
  app.put<ShiftParams>('/api/events/:eventId/shifts/:shiftId', async (request) => {
    const account = requireOrganizer(request);
    const { eventId, shiftId } = request.params;
    const body = readBody(request);
    const previous = body.previous;
    if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) {
      throw new RosterError(409, 'Open the current shift to edit it.');
    }
    return database.updateShift(account.id, eventId, shiftId, readShiftDetails(body),
      readShiftDetails(previous as Record<string, unknown>), body.confirmTimeChange === true);
  });

  app.post<EventParams>('/api/events/:eventId/reopen', async (request) => database.reopen(requireOrganizer(request).id, request.params.eventId, readRosterRevision(request)));
  app.post<EventParams>('/api/events/:eventId/publish', async (request) => database.publish(requireOrganizer(request).id, request.params.eventId));
  app.put<VolunteerParams>('/api/events/:eventId/volunteers/:volunteerId/withdrawal', async (request) => {
    const account = requireOrganizer(request);
    const { withdrawn, revision, availabilityRevision } = readBody(request);
    if (withdrawn === false) throw new RosterError(403, 'Volunteers can restore their own participation through the event link.');
    if (withdrawn !== true) throw new RosterError(400, 'Specify that the volunteer has withdrawn.');
    const { eventId, volunteerId } = request.params;
    return database.recordVolunteerDropout(account.id, eventId, volunteerId, readWithdrawalRevision(revision), availabilityRevision);
  });

  app.get<EventParams>('/api/join/:eventId', async (request) => database.viewSignup(request.params.eventId, volunteerCode(request)));
  app.post<EventParams>('/api/join/:eventId', async (request, reply) => {
    const { name, signupAttempt } = readBody(request);
    if (signupAttempt !== undefined && (typeof signupAttempt !== 'string' || !/^[0-9a-f]{64}$/.test(signupAttempt))) {
      throw new RosterError(400, 'Open the event again before signing up.');
    }
    const code = database.joinEvent(request.params.eventId, readName(name), volunteerCode(request), signupAttempt);
    reply.header('Set-Cookie', volunteerCookie(request, code, volunteerSessionLifetime));
    return reply.code(201).send({ code });
  });
  app.post<EventParams>('/api/join/:eventId/session', async (request, reply) => {
    const { code } = readBody(request);
    const candidate = typeof code === 'string' ? code.trim() : '';
    if (!database.viewSignup(request.params.eventId, candidate).signedIn) {
      throw new RosterError(401, 'That recovery code does not match this event.');
    }
    reply.header('Set-Cookie', volunteerCookie(request, candidate, volunteerSessionLifetime));
    return { signedIn: true };
  });
  app.delete<EventParams>('/api/join/:eventId/session', async (request, reply) => {
    database.viewSignup(request.params.eventId, '');
    reply.header('Set-Cookie', volunteerCookie(request, '', 0));
    return { signedIn: false };
  });
  app.get<EventParams>('/api/join/:eventId/recovery-code', async (request) => {
    const code = volunteerCode(request);
    if (!database.viewSignup(request.params.eventId, code).signedIn) {
      throw new RosterError(401, 'Sign in to see your recovery code.');
    }
    return { code };
  });

  app.get<EventParams>('/api/join/:eventId/volunteer', async (request) => database.viewInvitation(volunteerCode(request), request.params.eventId));
  app.put<EventParams>('/api/join/:eventId/volunteer/availability', async (request) => {
    const { shiftIds, volunteerId, revision } = readBody(request);
    return database.updateAvailability(volunteerCode(request), readShiftIds(shiftIds), revision, request.params.eventId, readVolunteerId(volunteerId));
  });
  app.post<EventParams>('/api/join/:eventId/volunteer/withdraw', async (request) => {
    const { revision, availabilityRevision, volunteerId } = readBody(request);
    return database.updateInvitationWithdrawal(volunteerCode(request), true, readWithdrawalRevision(revision),
      availabilityRevision, request.params.eventId, readVolunteerId(volunteerId));
  });
  app.post<EventParams>('/api/join/:eventId/volunteer/restore', async (request) => {
    const { revision, availabilityRevision, volunteerId } = readBody(request);
    return database.updateInvitationWithdrawal(volunteerCode(request), false, readWithdrawalRevision(revision),
      availabilityRevision, request.params.eventId, readVolunteerId(volunteerId));
  });

  app.get<InvitationParams>('/api/invitations/:token', async (request) => database.viewInvitation(request.params.token));
  app.post<InvitationParams>('/api/invitations/:token/withdraw', async (request) => {
    const { revision, availabilityRevision } = request.body === undefined ? {} : readBody(request);
    return database.updateInvitationWithdrawal(request.params.token, true, readWithdrawalRevision(revision), availabilityRevision);
  });
  app.post<InvitationParams>('/api/invitations/:token/restore', async (request) => {
    const { revision, availabilityRevision } = request.body === undefined ? {} : readBody(request);
    return database.updateInvitationWithdrawal(request.params.token, false, readWithdrawalRevision(revision), availabilityRevision);
  });

  app.put<InvitationParams>('/api/invitations/:token/availability', async (request) => {
    const { shiftIds, revision } = readBody(request);
    return database.updateAvailability(request.params.token, readShiftIds(shiftIds), revision);
  });

  if (existsSync(resolve(distPath, 'index.html'))) {
    app.register(fastifyStatic, { root: distPath, dotfiles: 'deny', index: false });
    const sendApp = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html', { cacheControl: false });
    };
    app.get('/', sendApp);
    app.get('/index.html', sendApp);
    app.get('/invite/:token', sendApp);
    app.get('/join/:eventId', sendApp);
  }

  return app;
}

if (import.meta.main) {
  const app = buildServer({
    databasePath: process.env.ROSTER_READY_DB_PATH,
  });
  const address = await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
  console.log(`RosterReady listening at ${address}`);
}
