import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventDetail, EventShift, EventSummary, EventVolunteer, InvitationDetail, OrganizerAccount, SignupPage } from './event.ts';
import { generateRoster, type Roster } from './scheduler.ts';
import { firstOverlappingPair } from './shift-times.ts';

type Invitation = {
  volunteerId: string;
  volunteerName: string;
  eventId: string;
  responded: number;
  withdrawn: number;
  availabilityRevision: string;
};

type OrganizerCredentials = OrganizerAccount & { salt: string; hash: string; passwordNfc: number };
type ShiftDetails = Omit<EventShift, 'id'>;

export class RosterError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function hashInvitation(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function openRosterDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS organizers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_nfc INTEGER NOT NULL DEFAULT 0 CHECK (password_nfc IN (0, 1))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'published'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      UNIQUE (event_id, id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS volunteers (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      name TEXT NOT NULL,
      invite_digest TEXT NOT NULL UNIQUE,
      responded INTEGER NOT NULL DEFAULT 0 CHECK (responded IN (0, 1)),
      UNIQUE (event_id, id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS availability (
      event_id TEXT NOT NULL,
      volunteer_id TEXT NOT NULL,
      shift_id TEXT NOT NULL,
      PRIMARY KEY (event_id, volunteer_id, shift_id),
      FOREIGN KEY (event_id, volunteer_id) REFERENCES volunteers(event_id, id),
      FOREIGN KEY (event_id, shift_id) REFERENCES shifts(event_id, id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rosters (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
    ) STRICT;
  `);

  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  transaction(() => {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('organizers') WHERE name = 'password_nfc'").get()) {
      db.exec('ALTER TABLE organizers ADD COLUMN password_nfc INTEGER NOT NULL DEFAULT 0 CHECK (password_nfc IN (0, 1))');
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'organizer_id'").get()) {
      db.exec('ALTER TABLE events ADD COLUMN organizer_id TEXT REFERENCES organizers(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS organizer_events ON events(organizer_id)');
    if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'creation_id'").get()) {
      db.exec('ALTER TABLE events ADD COLUMN creation_id TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS event_creation_requests ON events(organizer_id, creation_id)');
    if (!db.prepare("SELECT 1 FROM pragma_table_info('shifts') WHERE name = 'creation_id'").get()) {
      db.exec('ALTER TABLE shifts ADD COLUMN creation_id TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS shift_creation_requests ON shifts(event_id, creation_id)');
    if (!db.prepare("SELECT 1 FROM pragma_table_info('volunteers') WHERE name = 'withdrawn'").get()) {
      db.exec('ALTER TABLE volunteers ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1))');
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('volunteers') WHERE name = 'availability_revision'").get()) {
      db.exec('ALTER TABLE volunteers ADD COLUMN availability_revision TEXT');
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('rosters') WHERE name = 'revision'").get()) {
      db.exec('ALTER TABLE rosters ADD COLUMN revision TEXT');
    }
    db.exec(`
      DELETE FROM rosters WHERE event_id IN (SELECT id FROM events WHERE status = 'draft');
      UPDATE events SET status = 'collecting' WHERE status = 'draft';
    `);
  });

  function getEvent(eventId: string): EventSummary {
    const event = db.prepare('SELECT id, name, date, status FROM events WHERE id = ?').get(eventId);
    if (event === undefined) throw new RosterError(404, 'Event not found.');
    return event as EventSummary;
  }

  function getOwnedEvent(organizerId: string, eventId: string): EventSummary {
    const event = db.prepare('SELECT id, name, date, status FROM events WHERE id = ? AND organizer_id = ?').get(eventId, organizerId);
    if (event === undefined) throw new RosterError(404, 'Event not found.');
    return event as EventSummary;
  }

  function requireCollection(event: EventSummary): void {
    if (event.status !== 'collecting') throw new RosterError(409, 'Availability collection is closed.');
  }

  function getShifts(eventId: string): EventShift[] {
    return db.prepare(`
      SELECT id, name, capacity, start_time AS startTime, end_time AS endTime
      FROM shifts WHERE event_id = ? ORDER BY rowid
    `).all(eventId) as EventShift[];
  }

  function getAvailability(eventId: string, volunteerId: string): string[] {
    return db.prepare(`
      SELECT shifts.id FROM availability
      JOIN shifts ON shifts.event_id = availability.event_id AND shifts.id = availability.shift_id
      WHERE availability.event_id = ? AND availability.volunteer_id = ?
      ORDER BY shifts.rowid
    `).all(eventId, volunteerId).map(({ id }) => id as string);
  }

  function getVolunteers(eventId: string): EventVolunteer[] {
    const rows = db.prepare(`
      SELECT id, name, responded, withdrawn, COALESCE(availability_revision, id) AS availabilityRevision
      FROM volunteers WHERE event_id = ? ORDER BY rowid
    `).all(eventId) as { id: string; name: string; responded: number; withdrawn: number; availabilityRevision: string }[];
    return rows.map(({ id, name, responded, withdrawn, availabilityRevision }) => ({
      id, name, responded: responded === 1, withdrawn: withdrawn === 1, availabilityRevision,
      availableShiftIds: getAvailability(eventId, id),
    }));
  }

  function getRoster(eventId: string): { roster: Roster; rosterRevision: string } | null {
    const row = db.prepare('SELECT snapshot, COALESCE(revision, event_id) AS revision FROM rosters WHERE event_id = ?').get(eventId);
    if (!row) return null;
    return { roster: JSON.parse(row.snapshot as string) as Roster, rosterRevision: row.revision as string };
  }

  function describeEvent(event: EventSummary): EventDetail {
    const saved = event.status === 'collecting' ? null : getRoster(event.id);
    return {
      ...event,
      shifts: getShifts(event.id),
      volunteers: getVolunteers(event.id),
      roster: saved?.roster ?? null,
      rosterRevision: saved?.rosterRevision ?? null,
    };
  }

  function lookupInvitation(token: string, eventId?: string): Invitation | undefined {
    const pattern = eventId === undefined ? /^[\w-]{43}$/ : /^[\w-]{24}$/;
    if (!pattern.test(token)) return undefined;
    const row = db.prepare(`
      SELECT id AS volunteerId, name AS volunteerName, event_id AS eventId, responded, withdrawn,
        COALESCE(availability_revision, id) AS availabilityRevision
      FROM volunteers WHERE invite_digest = ?
    `).get(hashInvitation(token));
    if (row === undefined || (eventId !== undefined && row.eventId !== eventId)) return undefined;
    return row as Invitation;
  }

  function findInvitation(token: string, eventId?: string): Invitation {
    const invitation = lookupInvitation(token, eventId);
    if (invitation) return invitation;
    if (eventId !== undefined) throw new RosterError(401, 'Sign in with your recovery code to open your response.');
    throw new RosterError(404, 'Invitation not found.');
  }

  function requireSameVolunteer(invitation: Invitation, expectedVolunteerId?: string): void {
    if (expectedVolunteerId !== undefined && invitation.volunteerId !== expectedVolunteerId) {
      throw new RosterError(409, 'This browser switched volunteers. Review the current response before making changes.');
    }
  }

  function describeInvitation(invitation: Invitation, event: EventSummary): InvitationDetail {
    const shifts = getShifts(event.id);
    const published = event.status === 'published' ? getRoster(event.id) : null;
    const assignedIds = new Set(published?.roster.assignments
      .filter(({ volunteerId }) => volunteerId === invitation.volunteerId)
      .map(({ shiftId }) => shiftId));
    const assignments = shifts.filter(({ id }) => assignedIds.has(id));
    assignments.sort((left, right) => left.startTime.localeCompare(right.startTime));
    const withdrawn = invitation.withdrawn === 1;
    return {
      event,
      volunteer: { id: invitation.volunteerId, name: invitation.volunteerName },
      shifts,
      availableShiftIds: getAvailability(event.id, invitation.volunteerId),
      availabilityRevision: invitation.availabilityRevision,
      responded: invitation.responded === 1,
      withdrawn,
      canRestoreAssignment: withdrawn && assignments.length > 0,
      rosterRevision: published?.rosterRevision ?? null,
      assignments: withdrawn ? [] : assignments,
      assignment: withdrawn ? null : assignments[0] ?? null,
    };
  }

  function setWithdrawal(event: EventSummary, volunteerId: string, withdrawn: boolean, revision: string | null | undefined, expectedAvailabilityRevision: unknown): string {
    const published = event.status === 'published' ? getRoster(event.id) : null;
    if (revision !== (published?.rosterRevision ?? null)) {
      throw new RosterError(409, 'The roster changed. Review the latest roster before updating participation.');
    }
    if (event.status === 'published' && !published?.roster.assignments.some((entry) => entry.volunteerId === volunteerId)) {
      throw new RosterError(409, 'This volunteer has no published assignment to update.');
    }
    const current = db.prepare('SELECT COALESCE(availability_revision, id) AS revision FROM volunteers WHERE event_id = ? AND id = ?')
      .get(event.id, volunteerId);
    if (!current) throw new RosterError(404, 'Volunteer not found.');
    if (expectedAvailabilityRevision !== current.revision) {
      throw new RosterError(409, 'Participation changed. Review the latest response before trying again.');
    }
    const availabilityRevision = randomUUID();
    db.prepare('UPDATE volunteers SET withdrawn = ?, availability_revision = ? WHERE event_id = ? AND id = ?')
      .run(Number(withdrawn), availabilityRevision, event.id, volunteerId);
    return availabilityRevision;
  }

  function requireRosterRevision(event: EventSummary, revision: string): void {
    if (getRoster(event.id)?.rosterRevision !== revision) {
      throw new RosterError(409, 'The roster changed. Review the latest roster first.');
    }
  }

  return {
    close() {
      db.close();
    },

    createOrganizer(username: string, salt: string, hash: string): OrganizerAccount {
      const id = randomUUID();
      const result = db.prepare(`
        INSERT INTO organizers (id, username, password_salt, password_hash, password_nfc)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(username) DO NOTHING
      `).run(id, username, salt, hash);
      if (result.changes === 0) throw new RosterError(409, 'That username is already taken.');
      return { id, username };
    },

    findOrganizer(username: string): OrganizerCredentials | undefined {
      return db.prepare(`
        SELECT id, username, password_salt AS salt, password_hash AS hash, password_nfc AS passwordNfc
        FROM organizers WHERE username = ?
      `).get(username) as OrganizerCredentials | undefined;
    },

    listEvents(organizerId: string): EventSummary[] {
      return db.prepare('SELECT id, name, date, status FROM events WHERE organizer_id = ? ORDER BY rowid DESC').all(organizerId) as EventSummary[];
    },

    createEvent(organizerId: string, name: string, date: string, requestId?: string): EventDetail {
      return transaction(() => {
        if (requestId) {
          const saved = db.prepare(`
            SELECT id, name, date, status FROM events WHERE organizer_id = ? AND creation_id = ?
          `).get(organizerId, requestId) as EventSummary | undefined;
          if (saved) return describeEvent(saved);
        }
        const id = randomUUID();
        db.prepare('INSERT INTO events (id, name, date, organizer_id, creation_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, name, date, organizerId, requestId ?? null);
        return describeEvent(getOwnedEvent(organizerId, id));
      });
    },

    viewEvent(organizerId: string, eventId: string): EventDetail {
      return describeEvent(getOwnedEvent(organizerId, eventId));
    },

    createShift(organizerId: string, eventId: string, details: ShiftDetails, requestId?: string): EventShift {
      return transaction(() => {
        const event = getOwnedEvent(organizerId, eventId);
        if (requestId) {
          const saved = db.prepare(`
            SELECT id, name, capacity, start_time AS startTime, end_time AS endTime
            FROM shifts WHERE event_id = ? AND creation_id = ?
          `).get(eventId, requestId) as EventShift | undefined;
          if (saved) return saved;
        }
        requireCollection(event);
        const shift = { id: randomUUID(), ...details };
        db.prepare(`
          INSERT INTO shifts (id, event_id, name, capacity, start_time, end_time, creation_id) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(shift.id, eventId, shift.name, shift.capacity, shift.startTime, shift.endTime, requestId ?? null);
        return shift;
      });
    },

    updateShift(organizerId: string, eventId: string, shiftId: string, details: ShiftDetails, previous: ShiftDetails, confirmTimeChange: boolean): EventDetail {
      return transaction(() => {
        const event = getOwnedEvent(organizerId, eventId);
        if (event.status === 'published') throw new RosterError(409, 'Unpublish the roster before editing shifts.');
        const shift = db.prepare('SELECT name, capacity, start_time, end_time FROM shifts WHERE event_id = ? AND id = ?').get(eventId, shiftId);
        if (!shift) throw new RosterError(404, 'This shift may have changed. Open the current shift to edit it.');
        if (shift.name !== previous.name || shift.capacity !== previous.capacity ||
            shift.start_time !== previous.startTime || shift.end_time !== previous.endTime) {
          throw new RosterError(409, 'This shift changed. Open the current shift to edit it.');
        }

        let updatedId = shiftId;
        if (shift.start_time !== details.startTime || shift.end_time !== details.endTime) {
          if (!confirmTimeChange) throw new RosterError(409, 'Confirm the time change before saving the shift.');
          db.prepare(`
            UPDATE volunteers SET availability_revision = ?, responded = CASE WHEN EXISTS (
              SELECT 1 FROM availability
              WHERE event_id = volunteers.event_id AND volunteer_id = volunteers.id AND shift_id <> ?
            ) THEN responded ELSE 0 END
            WHERE event_id = ? AND id IN (
              SELECT volunteer_id FROM availability WHERE event_id = ? AND shift_id = ?
            )
          `).run(randomUUID(), shiftId, eventId, eventId, shiftId);
          db.prepare('DELETE FROM availability WHERE event_id = ? AND shift_id = ?').run(eventId, shiftId);
          // A volunteer form opened before the edit still refers to the old shift ID.
          updatedId = randomUUID();
        }
        db.prepare(`
          UPDATE shifts SET id = ?, name = ?, capacity = ?, start_time = ?, end_time = ?
          WHERE event_id = ? AND id = ?
        `).run(updatedId, details.name, details.capacity, details.startTime, details.endTime, eventId, shiftId);
        return describeEvent(event);
      });
    },

    viewSignup(eventId: string, code: string): SignupPage {
      const event = getEvent(eventId);
      return { event, signedIn: lookupInvitation(code, eventId) !== undefined };
    },

    joinEvent(eventId: string, name: string, existingCode: string, signupAttempt?: string): string {
      return transaction(() => {
        const event = getEvent(eventId);
        // Reproduce the code for a retry without storing the recovery credential.
        const code = signupAttempt
          ? createHash('sha256').update(`roster-ready-signup:${eventId}:${signupAttempt}`).digest().subarray(0, 18).toString('base64url')
          : randomBytes(18).toString('base64url');
        if (existingCode !== code && lookupInvitation(existingCode, eventId)) {
          throw new RosterError(409, 'You’re already signed up on this browser.');
        }
        if (signupAttempt && lookupInvitation(code, eventId)) return code;
        if (event.status !== 'collecting') throw new RosterError(409, 'Sign-ups are closed for this event.');
        const id = randomUUID();
        db.prepare(`
          INSERT INTO volunteers (id, event_id, name, invite_digest) VALUES (?, ?, ?, ?)
        `).run(id, eventId, name, hashInvitation(code));
        return code;
      });
    },

    viewInvitation(token: string, eventId?: string): InvitationDetail {
      const invitation = findInvitation(token, eventId);
      return describeInvitation(invitation, getEvent(invitation.eventId));
    },

    updateAvailability(token: string, shiftIds: readonly string[], revision: unknown, eventId?: string, expectedVolunteerId?: string): InvitationDetail {
      return transaction(() => {
        const invitation = findInvitation(token, eventId);
        requireSameVolunteer(invitation, expectedVolunteerId);
        const event = getEvent(invitation.eventId);
        requireCollection(event);
        const selectedShifts = new Set(shiftIds);
        const selection = getShifts(event.id).filter(({ id }) => selectedShifts.has(id));
        if (selection.length !== selectedShifts.size) throw new RosterError(409, 'Shift options changed. Review the current times and save again.');
        if (revision !== invitation.availabilityRevision) {
          throw new RosterError(409, 'Your availability changed. Review the saved choices before trying again.');
        }
        const overlap = firstOverlappingPair(selection);
        if (overlap) throw new RosterError(400, `${overlap[0].name} and ${overlap[1].name} overlap. Choose only one of them.`);
        db.prepare('DELETE FROM availability WHERE event_id = ? AND volunteer_id = ?').run(event.id, invitation.volunteerId);
        const insert = db.prepare('INSERT INTO availability (event_id, volunteer_id, shift_id) VALUES (?, ?, ?)');
        for (const shiftId of selectedShifts) insert.run(event.id, invitation.volunteerId, shiftId);
        const availabilityRevision = randomUUID();
        db.prepare('UPDATE volunteers SET responded = 1, withdrawn = 0, availability_revision = ? WHERE event_id = ? AND id = ?')
          .run(availabilityRevision, event.id, invitation.volunteerId);
        return describeInvitation({ ...invitation, responded: 1, withdrawn: 0, availabilityRevision }, event);
      });
    },

    updateInvitationWithdrawal(token: string, withdrawn: boolean, revision: string | null | undefined, expectedAvailabilityRevision: unknown, eventId?: string, expectedVolunteerId?: string): InvitationDetail {
      return transaction(() => {
        const invitation = findInvitation(token, eventId);
        requireSameVolunteer(invitation, expectedVolunteerId);
        const event = getEvent(invitation.eventId);
        if (!withdrawn && event.status !== 'published') {
          throw new RosterError(409, 'You can restore a shift after the roster is published.');
        }
        const availabilityRevision = setWithdrawal(event, invitation.volunteerId, withdrawn, revision, expectedAvailabilityRevision);
        return describeInvitation({ ...invitation, withdrawn: Number(withdrawn), availabilityRevision }, event);
      });
    },

    recordVolunteerDropout(organizerId: string, eventId: string, volunteerId: string, revision: string | null | undefined, expectedAvailabilityRevision: unknown): EventDetail {
      return transaction(() => {
        const event = getOwnedEvent(organizerId, eventId);
        setWithdrawal(event, volunteerId, true, revision, expectedAvailabilityRevision);
        return describeEvent(event);
      });
    },

    publish(organizerId: string, eventId: string): EventDetail {
      return transaction(() => {
        const event = getOwnedEvent(organizerId, eventId);
        if (event.status === 'published') throw new RosterError(409, 'This roster is already published.');
        const detail = describeEvent(event);
        if (detail.shifts.length === 0) throw new RosterError(409, 'Add at least one shift before publishing the roster.');
        const roster = generateRoster(detail.shifts, detail.volunteers.filter((volunteer) => !volunteer.withdrawn));
        const rosterRevision = randomUUID();
        db.prepare('INSERT INTO rosters (event_id, snapshot, revision) VALUES (?, ?, ?)').run(eventId, JSON.stringify(roster), rosterRevision);
        db.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(eventId);
        return { ...detail, status: 'published', roster, rosterRevision };
      });
    },

    reopen(organizerId: string, eventId: string, revision: string): EventDetail {
      return transaction(() => {
        const event = getOwnedEvent(organizerId, eventId);
        if (event.status === 'collecting') throw new RosterError(409, 'Availability is already open.');
        requireRosterRevision(event, revision);
        db.prepare('DELETE FROM rosters WHERE event_id = ?').run(eventId);
        db.prepare("UPDATE events SET status = 'collecting' WHERE id = ?").run(eventId);
        return describeEvent({ ...event, status: 'collecting' });
      });
    },

  };
}
