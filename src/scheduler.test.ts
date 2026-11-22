import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateRoster, type Roster, type Shift, type Volunteer } from './scheduler.ts';
import { firstOverlappingPair, shiftTimesOverlap } from './shift-times.ts';

const shifts = [
  { id: 'Setup', capacity: 2, startTime: '08:00', endTime: '09:00' },
  { id: 'Welcome', capacity: 1, startTime: '09:00', endTime: '11:00' },
  { id: 'Cleanup', capacity: 1, startTime: '11:00', endTime: '12:00' },
] satisfies readonly Shift[];

const volunteersWithoutOmar = [
  { id: 'Ivy', availableShiftIds: ['Setup', 'Welcome'] },
  { id: 'Ken', availableShiftIds: ['Setup'] },
  { id: 'Lena', availableShiftIds: ['Welcome', 'Cleanup'] },
] satisfies readonly Volunteer[];

function assertValidRoster(roster: Roster, calendar: readonly Shift[], volunteers: readonly Volunteer[]): void {
  const volunteersById = new Map(volunteers.map((volunteer) => [volunteer.id, volunteer]));
  const shiftsById = new Map(calendar.map((shift) => [shift.id, shift]));
  const assignedByVolunteer = new Map<string, Shift[]>();
  const filledByShift = new Map<string, number>();

  for (const { volunteerId, shiftId } of roster.assignments) {
    const shift = shiftsById.get(shiftId);
    assert.ok(shift, `Unknown shift ${shiftId}`);
    const volunteer = volunteersById.get(volunteerId);
    assert.ok(volunteer?.availableShiftIds.includes(shiftId), `${volunteerId} is unavailable for ${shiftId}`);
    const assigned = assignedByVolunteer.get(volunteerId) ?? [];
    assert.ok(!assigned.some((other) => shiftTimesOverlap(shift, other)), `${volunteerId} has overlapping assignments`);
    assigned.push(shift);
    assignedByVolunteer.set(volunteerId, assigned);
    filledByShift.set(shiftId, (filledByShift.get(shiftId) ?? 0) + 1);
  }

  const expectedVacancies: Roster['vacancies'] = [];
  for (const { id, capacity } of calendar) {
    const filled = filledByShift.get(id) ?? 0;
    assert.ok(filled <= capacity, `${id} exceeds its headcount`);
    if (filled < capacity) expectedVacancies.push({ shiftId: id, count: capacity - filled });
  }
  assert.deepEqual(roster.vacancies, expectedVacancies);
}

test('fills all four slots in the four-volunteer example', () => {
  const volunteers = [...volunteersWithoutOmar, { id: 'Omar', availableShiftIds: ['Setup'] }];
  const roster = generateRoster(shifts, volunteers);

  assertValidRoster(roster, shifts, volunteers);
  assert.deepEqual(roster.assignments, [
    { volunteerId: 'Ivy', shiftId: 'Setup' },
    { volunteerId: 'Ken', shiftId: 'Setup' },
    { volunteerId: 'Ivy', shiftId: 'Welcome' },
    { volunteerId: 'Lena', shiftId: 'Cleanup' },
  ]);
  assert.deepEqual(roster.vacancies, []);
});

test('still fills four slots without Omar when Ivy can cover two shifts', () => {
  const roster = generateRoster(shifts, volunteersWithoutOmar);

  assertValidRoster(roster, shifts, volunteersWithoutOmar);
  assert.equal(roster.assignments.length, 4);
  assert.deepEqual(roster.vacancies, []);
});

test('Mr A fills both teacher and presentation and leaves 16 vacancies', () => {
  const calendar = [
    { id: 'ta', capacity: 13, startTime: '00:55', endTime: '13:55' },
    { id: 'teacher', capacity: 4, startTime: '10:55', endTime: '15:55' },
    { id: 'presentation', capacity: 1, startTime: '18:15', endTime: '21:15' },
  ];
  const volunteers = [{ id: 'Mr A', availableShiftIds: ['teacher', 'presentation'] }];
  const roster = generateRoster(calendar, volunteers);
  assertValidRoster(roster, calendar, volunteers);
  assert.deepEqual(roster.assignments, [
    { volunteerId: 'Mr A', shiftId: 'teacher' },
    { volunteerId: 'Mr A', shiftId: 'presentation' },
  ]);
  assert.deepEqual(roster.vacancies, [{ shiftId: 'ta', count: 13 }, { shiftId: 'teacher', count: 3 }]);
});

test('finds the maximum for an older response with conflicting availability', () => {
  const calendar = [
    { id: 'Long', capacity: 1, startTime: '08:00', endTime: '10:00' },
    { id: 'Early', capacity: 1, startTime: '08:00', endTime: '09:00' },
    { id: 'Late', capacity: 1, startTime: '09:00', endTime: '10:00' },
  ];
  const volunteers = [{ id: 'A', availableShiftIds: ['Long', 'Early', 'Late'] }];
  const roster = generateRoster(calendar, volunteers);
  assertValidRoster(roster, calendar, volunteers);
  assert.deepEqual(roster.assignments, [
    { volunteerId: 'A', shiftId: 'Early' },
    { volunteerId: 'A', shiftId: 'Late' },
  ]);
});

test('fills the maximum across separate and connected groups with overlapping legacy responses', () => {
  const groups = [
    { name: 'a', shifts: 5, volunteers: 7 },
    { name: 'b', shifts: 7, volunteers: 5 },
  ];
  const calendar = groups.flatMap((group) => Array.from({ length: group.shifts }, (_, index) =>
    ({ id: `${group.name}-shift-${index}`, capacity: 1, startTime: '08:00', endTime: '09:00' })));
  const volunteers = groups.flatMap((group) => Array.from({ length: group.volunteers }, (_, index) => ({
    id: `${group.name}-volunteer-${index}`,
    availableShiftIds: calendar.filter(({ id }) => id.startsWith(group.name)).map(({ id }) => id),
  })));
  const roster = generateRoster(calendar, volunteers);
  assertValidRoster(roster, calendar, volunteers);
  assert.equal(roster.assignments.length, 10);

  const connected = volunteers.map((volunteer, index) => index === 0
    ? { ...volunteer, availableShiftIds: [...volunteer.availableShiftIds, 'b-shift-0'] }
    : volunteer);
  const connectedRoster = generateRoster(calendar, connected);
  assertValidRoster(connectedRoster, calendar, connected);
  assert.equal(connectedRoster.assignments.length, 11);
});

test('finds the optimum promptly for mixed overlapping legacy availability', () => {
  const slot = (id: string, startTime = '08:00', endTime = '09:00') => ({ id, capacity: 1, startTime, endTime });
  const first = Array.from({ length: 7 }, (_, index) => slot(`a${index}`));
  const second = Array.from({ length: 5 }, (_, index) => slot(`b${index}`));
  const calendar = [...first, ...second, slot('early', '07:30', '08:30'), slot('late', '08:30', '09:30')];
  const volunteers = [
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `x${index}`, availableShiftIds: [...first.map(({ id }) => id), ...(index === 0 ? ['b0', 'early', 'late'] : [])],
    })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `y${index}`, availableShiftIds: second.map(({ id }) => id) })),
  ];
  const start = performance.now();
  const roster = generateRoster(calendar, volunteers);
  assert.ok(performance.now() - start < 2_000, 'The legacy fixture should publish in under two seconds');
  assertValidRoster(roster, calendar, volunteers);
  assert.equal(roster.assignments.length, 12);
});

test('reports exact vacancies when nobody is available', () => {
  assert.deepEqual(generateRoster(shifts, [{ id: 'Unavailable', availableShiftIds: [] }]), {
    assignments: [],
    vacancies: shifts.map(({ id, capacity }) => ({ shiftId: id, count: capacity })),
  });
});

test('agrees with exhaustive assignment search for 1,024 small availability combinations', () => {
  const possibilities = Array.from({ length: 8 }, (_, mask) =>
    shifts.filter((_, index) => (mask & (1 << index)) !== 0).map(({ id }) => id),
  );
  const allowable = possibilities.length;
  const overlapping = shifts.map((shift) => shift.id === 'Welcome' ? { ...shift, endTime: '11:30' } : shift);
  for (const calendar of [shifts, overlapping]) {
    for (let combination = 0; combination < allowable ** 3; combination++) {
      const volunteers = ['A', 'B', 'C'].map((id, index) => ({
        id, availableShiftIds: possibilities[Math.floor(combination / allowable ** index) % allowable],
      }));
      const roster = generateRoster(calendar, volunteers);
      assertValidRoster(roster, calendar, volunteers);
      assert.equal(roster.assignments.length, maximumByEnumeration(calendar, volunteers), `availability combination ${combination}`);
    }
  }
});

function maximumByEnumeration(calendar: readonly Shift[], volunteers: readonly Volunteer[]): number {
  const remaining = new Map(calendar.map(({ id, capacity }) => [id, capacity]));
  function search(index: number): number {
    if (index === volunteers.length) return 0;
    const available = calendar.filter(({ id }) => volunteers[index].availableShiftIds.includes(id));
    let best = 0;
    for (let mask = 0; mask < 2 ** available.length; mask++) {
      const picked = available.filter((_, position) => mask & (1 << position));
      if (firstOverlappingPair(picked) || picked.some(({ id }) => remaining.get(id) === 0)) continue;
      for (const { id } of picked) remaining.set(id, remaining.get(id)! - 1);
      best = Math.max(best, picked.length + search(index + 1));
      for (const { id } of picked) remaining.set(id, remaining.get(id)! + 1);
    }
    return best;
  }
  return search(0);
}
