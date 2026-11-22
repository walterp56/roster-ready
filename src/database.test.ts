import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openRosterDatabase, RosterError } from './database.ts';

test('a failed publication rolls back the roster and keeps collection open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roster-rollback-'));
  const path = join(directory, 'test.sqlite');
  const app = openRosterDatabase(path);
  const sqlite = new DatabaseSync(path);

  try {
    const organizer = app.createOrganizer('test-organizer', 'fixture-salt', 'fixture-hash');
    const event = app.createEvent(organizer.id, 'Rollback example', '2026-12-05');
    const shift = app.createShift(organizer.id, event.id, { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' });
    const code = app.joinEvent(event.id, 'Sample volunteer', '');
    const invitation = app.viewInvitation(code, event.id);
    const { volunteer } = invitation;

    sqlite.exec(`
      CREATE TRIGGER fail_publish BEFORE UPDATE OF status ON events
      WHEN NEW.status = 'published'
      BEGIN SELECT RAISE(ABORT, 'publish write failed'); END;
    `);
    assert.throws(() => app.publish(organizer.id, event.id), /publish write failed/);
    assert.equal(app.viewEvent(organizer.id, event.id).status, 'collecting');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM rosters WHERE event_id = ?').get(event.id)?.total, 0);
    assert.deepEqual(app.updateAvailability(code, [shift.id], invitation.availabilityRevision, event.id, volunteer.id).availableShiftIds, [shift.id]);

    sqlite.exec('DROP TRIGGER fail_publish');
    const published = app.publish(organizer.id, event.id);
    assert.equal(published.status, 'published');
    assert.deepEqual(published.roster, {
      assignments: [{ volunteerId: volunteer.id, shiftId: shift.id }],
      vacancies: [],
    });
  } finally {
    sqlite.close();
    app.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('existing drafts reopen with saved availability while published rosters survive the upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roster-legacy-draft-'));
  const path = join(directory, 'test.sqlite');
  const sqlite = new DatabaseSync(path);

  try {
    sqlite.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'draft', 'published'))
      ) STRICT;
    `);
    const old = openRosterDatabase(path);
    const { organizer, draft, published, shift, code } = (() => {
      try {
        const organizer = old.createOrganizer('test-organizer', 'fixture-salt', 'fixture-hash');
        const draft = old.createEvent(organizer.id, 'Old draft', '2026-12-05');
        const published = old.createEvent(organizer.id, 'Already public', '2026-12-05');
        const setup = { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' };
        const shift = old.createShift(organizer.id, draft.id, setup);
        const code = old.joinEvent(draft.id, 'Sample volunteer', '');
        old.updateAvailability(code, [shift.id], old.viewInvitation(code, draft.id).availabilityRevision, draft.id);
        old.publish(organizer.id, draft.id);
        old.createShift(organizer.id, published.id, setup);
        return { organizer, draft, published: old.publish(organizer.id, published.id), shift, code };
      } finally {
        old.close();
      }
    })();
    sqlite.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(draft.id);

    const upgraded = openRosterDatabase(path);
    try {
      const event = upgraded.viewEvent(organizer.id, draft.id);
      assert.equal(event.status, 'collecting');
      assert.equal(event.roster, null);
      assert.deepEqual(event.volunteers[0].availableShiftIds, [shift.id]);
      assert.deepEqual(upgraded.viewInvitation(code, draft.id).assignments, []);
      assert.deepEqual(upgraded.viewEvent(organizer.id, published.id), published);
      assert.equal(upgraded.publish(organizer.id, draft.id).status, 'published');
    } finally {
      upgraded.close();
    }
  } finally {
    sqlite.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('a volunteer can restore all their own shifts only after publication', () => {
  const app = openRosterDatabase(':memory:');
  try {
    const organizer = app.createOrganizer('restore-organizer', 'fixture-salt', 'fixture-hash');
    const event = app.createEvent(organizer.id, 'Restoration example', '2026-12-05');
    const shift = app.createShift(organizer.id, event.id, { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' });
    const later = app.createShift(organizer.id, event.id, { name: 'Close', capacity: 1, startTime: '12:00', endTime: '13:00' });
    const assignedCode = app.joinEvent(event.id, 'Assigned volunteer', '');
    const unassignedCode = app.joinEvent(event.id, 'Unavailable volunteer', '');
    const assigned = app.viewInvitation(assignedCode, event.id);
    const assignedId = assigned.volunteer.id;
    const unassignedBefore = app.viewInvitation(unassignedCode, event.id);
    const unassignedId = unassignedBefore.volunteer.id;
    app.updateAvailability(assignedCode, [shift.id, later.id], assigned.availabilityRevision, event.id, assignedId);
    app.updateInvitationWithdrawal(unassignedCode, true, null, unassignedBefore.availabilityRevision, event.id, unassignedId);

    const assignedBefore = app.viewInvitation(assignedCode, event.id);
    assert.throws(() => app.updateInvitationWithdrawal(assignedCode, false, null, assignedBefore.availabilityRevision, event.id, assignedId), /after the roster is published/);
    const published = app.publish(organizer.id, event.id);
    const unassigned = app.viewInvitation(unassignedCode, event.id);
    assert.equal(unassigned.canRestoreAssignment, false);
    assert.throws(() => app.updateInvitationWithdrawal(unassignedCode, false, published.rosterRevision, unassigned.availabilityRevision, event.id, unassignedId), /no published assignment/);

    app.recordVolunteerDropout(organizer.id, event.id, assignedId, published.rosterRevision, assignedBefore.availabilityRevision);
    const withdrawn = app.viewInvitation(assignedCode, event.id);
    assert.equal(withdrawn.canRestoreAssignment, true);
    assert.deepEqual(withdrawn.assignments, []);
    const restored = app.updateInvitationWithdrawal(assignedCode, false, published.rosterRevision, withdrawn.availabilityRevision, event.id, assignedId);
    assert.equal(restored.withdrawn, false);
    assert.equal(restored.canRestoreAssignment, false);
    assert.deepEqual(restored.assignments.map((assignment) => ({ ...assignment })), [shift, later]);
    assert.throws(() => app.updateInvitationWithdrawal(assignedCode, true, published.rosterRevision, assignedBefore.availabilityRevision, event.id, assignedId), /Participation changed/);
    assert.throws(() => app.recordVolunteerDropout(organizer.id, event.id, assignedId, published.rosterRevision, assignedBefore.availabilityRevision), /Participation changed/);
    assert.deepEqual(app.viewInvitation(assignedCode, event.id), restored);
    assert.deepEqual(app.viewEvent(organizer.id, event.id).roster, published.roster);
  } finally {
    app.close();
  }
});

test('moving a volunteer’s only selected shift puts their response back in awaiting status', () => {
  const app = openRosterDatabase(':memory:');
  try {
    const organizer = app.createOrganizer('edit-organizer', 'fixture-salt', 'fixture-hash');
    const event = app.createEvent(organizer.id, 'Shift edit example', '2026-12-05');
    const details = { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' };
    const shift = app.createShift(organizer.id, event.id, details);
    const code = app.joinEvent(event.id, 'Sample volunteer', '');
    const beforeEdit = app.updateAvailability(code, [shift.id], app.viewInvitation(code, event.id).availabilityRevision, event.id);
    const newDetails = { ...details, startTime: '08:15' };

    assert.throws(() => app.updateShift(organizer.id, event.id, shift.id, newDetails, details, false), /Confirm the time change/);
    assert.deepEqual(app.viewInvitation(code, event.id).availableShiftIds, [shift.id]);
    const updated = app.updateShift(organizer.id, event.id, shift.id, newDetails, details, true);
    assert.notEqual(updated.shifts[0].id, shift.id);
    assert.equal(updated.volunteers[0].responded, false);
    assert.deepEqual(updated.volunteers[0].availableShiftIds, []);
    assert.throws(() => app.updateAvailability(code, [shift.id], beforeEdit.availabilityRevision, event.id), /Shift options changed/);
    assert.notEqual(app.viewInvitation(code, event.id).availabilityRevision, beforeEdit.availabilityRevision);
    assert.equal(app.viewInvitation(code, event.id).responded, false);
  } finally {
    app.close();
  }
});

test('a saved availability revision survives restart and rejects a replay of an older revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roster-availability-restart-'));
  const path = join(directory, 'test.sqlite');
  try {
    const app = openRosterDatabase(path);
    const fixture = (() => {
      try {
        const organizer = app.createOrganizer('revision-organizer', 'fixture-salt', 'fixture-hash');
        const event = app.createEvent(organizer.id, 'Revision example', '2026-12-05');
        const shift = app.createShift(organizer.id, event.id, { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' });
        const code = app.joinEvent(event.id, 'Sample volunteer', '');
        const initial = app.viewInvitation(code, event.id);
        const selected = app.updateAvailability(code, [shift.id], initial.availabilityRevision, event.id);
        const cleared = app.updateAvailability(code, [], selected.availabilityRevision, event.id);
        const saved = app.updateAvailability(code, [shift.id], cleared.availabilityRevision, event.id);
        assert.notEqual(saved.availabilityRevision, selected.availabilityRevision);
        return { event, code, selected, saved };
      } finally {
        app.close();
      }
    })();
    const reopened = openRosterDatabase(path);
    try {
      const { event, code, selected, saved } = fixture;
      assert.deepEqual(reopened.viewInvitation(code, event.id), saved);
      assert.throws(
        () => reopened.updateAvailability(code, [], selected.availabilityRevision, event.id),
        (error) => error instanceof RosterError && error.statusCode === 409,
      );
      assert.deepEqual(reopened.viewInvitation(code, event.id), saved);
    } finally {
      reopened.close();
    }
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test('a form opened before an organizer records a withdrawal cannot reactivate the volunteer', () => {
  const app = openRosterDatabase(':memory:');
  try {
    const organizer = app.createOrganizer('withdrawal-organizer', 'fixture-salt', 'fixture-hash');
    const event = app.createEvent(organizer.id, 'Withdrawal example', '2026-12-05');
    const shift = app.createShift(organizer.id, event.id, { name: 'Setup', capacity: 1, startTime: '08:00', endTime: '09:00' });
    const code = app.joinEvent(event.id, 'Sample volunteer', '');
    const response = app.viewInvitation(code, event.id);
    app.recordVolunteerDropout(organizer.id, event.id, response.volunteer.id, null, response.availabilityRevision);

    assert.throws(
      () => app.updateAvailability(code, [shift.id], response.availabilityRevision, event.id),
      (error) => error instanceof RosterError && error.statusCode === 409,
    );
    const withdrawn = app.viewInvitation(code, event.id);
    assert.equal(withdrawn.withdrawn, true);
    assert.deepEqual(withdrawn.availableShiftIds, []);
    const returned = app.updateAvailability(code, [shift.id], withdrawn.availabilityRevision, event.id);
    assert.equal(returned.withdrawn, false);
    assert.deepEqual(returned.availableShiftIds, [shift.id]);
    assert.throws(() => app.updateInvitationWithdrawal(code, true, null, response.availabilityRevision, event.id), /Participation changed/);
    assert.deepEqual(app.viewInvitation(code, event.id), returned);
  } finally {
    app.close();
  }
});
