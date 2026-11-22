import { firstOverlappingPair, shiftTimesOverlap } from './shift-times.ts';

export type Shift = {
  readonly id: string;
  readonly capacity: number;
  readonly startTime: string;
  readonly endTime: string;
};

export type Volunteer = {
  readonly id: string;
  readonly availableShiftIds: readonly string[];
};

export type Roster = {
  assignments: { volunteerId: string; shiftId: string }[];
  vacancies: { shiftId: string; count: number }[];
};

type ShiftState = {
  shift: Shift;
  assignees: string[];
};

type Candidate = {
  volunteerId: string;
  state: ShiftState;
};

function assignConflictingAvailability(candidates: Candidate[]): void {
  const options = candidates.filter(({ state }) => state.assignees.length < state.shift.capacity);
  if (options.length === 0) return;

  const byShift = new Map<ShiftState, Candidate[]>();
  const byVolunteer = new Map<string, Candidate[]>();
  for (const option of options) {
    const shiftGroup = byShift.get(option.state) ?? [];
    shiftGroup.push(option);
    byShift.set(option.state, shiftGroup);
    const volunteerGroup = byVolunteer.get(option.volunteerId) ?? [];
    volunteerGroup.push(option);
    byVolunteer.set(option.volunteerId, volunteerGroup);
  }

  // Choices compete for a shift's seats or overlap on the same volunteer's schedule.
  const overlapGroup = new Map<Candidate, Candidate[]>();
  for (const choices of byVolunteer.values()) {
    let group: Candidate[] = [];
    let latestEnd = '';
    for (const option of choices.sort((a, b) => a.state.shift.startTime.localeCompare(b.state.shift.startTime))) {
      const { startTime, endTime } = option.state.shift;
      if (startTime >= latestEnd) group = [];
      group.push(option);
      overlapGroup.set(option, group);
      if (endTime > latestEnd) latestEnd = endTime;
    }
  }

  const unassigned = new Set(options);
  const visitedGroups = new Set<Candidate[]>();
  for (const first of unassigned) {
    const component = [first];
    unassigned.delete(first);
    for (const option of component) {
      for (const group of [byShift.get(option.state)!, overlapGroup.get(option)!]) {
        if (visitedGroups.has(group)) continue;
        visitedGroups.add(group);
        for (const choice of group) {
          if (unassigned.delete(choice)) component.push(choice);
        }
      }
    }
    assignConflictGroup(component);
  }
}

function matchShiftSeats(choices: Map<string, ShiftState[]>): Map<string, ShiftState> {
  const matchedShifts = new Map<string, ShiftState>();
  const matchedVolunteers = new Map<ShiftState, Set<string>>();
  for (const start of choices.keys()) {
    const queue = [start];
    const visited = new Set(queue);
    const previousVolunteer = new Map<ShiftState, string>();
    let vacancy: ShiftState | undefined;
    for (const volunteer of queue) {
      for (const state of choices.get(volunteer)!) {
        if (previousVolunteer.has(state)) continue;
        previousVolunteer.set(state, volunteer);
        const occupants = matchedVolunteers.get(state);
        if (state.assignees.length + (occupants?.size ?? 0) < state.shift.capacity) {
          vacancy = state;
          break;
        }
        for (const occupant of occupants ?? []) {
          if (!visited.has(occupant)) {
            visited.add(occupant);
            queue.push(occupant);
          }
        }
      }
      if (vacancy) break;
    }

    // Follow the augmenting path back, moving only matches made in this group.
    while (vacancy) {
      const volunteer = previousVolunteer.get(vacancy)!;
      const previousShift = matchedShifts.get(volunteer);
      if (previousShift) matchedVolunteers.get(previousShift)!.delete(volunteer);
      const occupants = matchedVolunteers.get(vacancy) ?? new Set<string>();
      occupants.add(volunteer);
      matchedVolunteers.set(vacancy, occupants);
      matchedShifts.set(volunteer, vacancy);
      vacancy = previousShift;
    }
  }
  return matchedShifts;
}

function assignConflictGroup(options: Candidate[]): void {
  const counts = new Map<ShiftState, number>();
  const shiftsByVolunteer = new Map<string, ShiftState[]>();
  for (const { volunteerId, state } of options) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
    const shifts = shiftsByVolunteer.get(volunteerId) ?? [];
    shifts.push(state);
    shiftsByVolunteer.set(volunteerId, shifts);
  }
  let remainingCapacity = 0;
  for (const [state, count] of counts) {
    remainingCapacity += Math.min(count, state.shift.capacity - state.assignees.length);
  }
  const limits = new Map<string, number>();
  let compatibleChoices = 0;
  for (const [volunteerId, shifts] of shiftsByVolunteer) {
    let end = '';
    let limit = 0;
    for (const { shift } of [...shifts].sort((a, b) => a.shift.endTime.localeCompare(b.shift.endTime))) {
      if (shift.startTime < end) continue;
      limit++;
      end = shift.endTime;
    }
    limits.set(volunteerId, limit);
    compatibleChoices += limit;
  }
  if (compatibleChoices === shiftsByVolunteer.size) {
    for (const [volunteerId, state] of matchShiftSeats(shiftsByVolunteer)) state.assignees.push(volunteerId);
    return;
  }
  // Matching ignores overlaps but caps each volunteer by the size of their largest
  // compatible schedule. Every valid solution fits this relaxed matching.
  const relaxed = new Map<string, ShiftState[]>();
  for (const [volunteerId, shifts] of shiftsByVolunteer) {
    for (let seat = 0; seat < limits.get(volunteerId)!; seat++) {
      relaxed.set(String(relaxed.size), shifts);
    }
  }
  const upperBound = Math.min(remainingCapacity, matchShiftSeats(relaxed).size);
  const current: Candidate[] = [];
  let best: Candidate[] = [];
  const selected = new Map<string, Shift[]>();

  function search(start: number): void {
    if (current.length > best.length) best = [...current];
    for (let index = start; index < options.length && best.length < upperBound; index++) {
      if (current.length + options.length - index <= best.length) break;
      const candidate = options[index];
      const { volunteerId, state } = candidate;
      if (state.assignees.length === state.shift.capacity) continue;
      const schedule = selected.get(volunteerId) ?? [];
      if (schedule.some((shift) => shiftTimesOverlap(shift, state.shift))) continue;

      selected.set(volunteerId, schedule);
      schedule.push(state.shift);
      state.assignees.push(volunteerId);
      current.push(candidate);
      search(index + 1);
      current.pop();
      state.assignees.pop();
      schedule.pop();
    }
  }

  search(0);
  for (const { volunteerId, state } of best) state.assignees.push(volunteerId);
}

/** Maximizes filled slots while respecting availability and each volunteer’s shift times. */
export function generateRoster(shifts: readonly Shift[], volunteers: readonly Volunteer[]): Roster {
  const shiftsById = new Map<string, ShiftState>();
  for (const shift of shifts) {
    if (shiftsById.has(shift.id)) throw new Error(`Duplicate shift ID: ${shift.id}`);
    if (!Number.isSafeInteger(shift.capacity) || shift.capacity < 0) {
      throw new RangeError(`Shift ${shift.id} must have a non-negative integer capacity`);
    }
    shiftsById.set(shift.id, { shift, assignees: [] });
  }

  const volunteerIds = new Set<string>();
  const conflicting: Candidate[] = [];
  for (const volunteer of volunteers) {
    if (volunteerIds.has(volunteer.id)) throw new Error(`Duplicate volunteer ID: ${volunteer.id}`);
    volunteerIds.add(volunteer.id);
    const availableShifts: ShiftState[] = [];
    for (const shiftId of new Set(volunteer.availableShiftIds)) {
      const shift = shiftsById.get(shiftId);
      if (shift === undefined) throw new Error(`Unknown shift ID in availability: ${shiftId}`);
      if (shift.shift.capacity > 0) availableShifts.push(shift);
    }
    const overlaps = firstOverlappingPair(availableShifts.map(({ shift }) => shift));
    for (const state of availableShifts) {
      const hasConflict = overlaps && availableShifts.some((other) =>
        other !== state && shiftTimesOverlap(state.shift, other.shift));
      if (hasConflict) conflicting.push({ volunteerId: volunteer.id, state });
      // Compatible choices can fill any open slot independently.
      else if (state.assignees.length < state.shift.capacity) state.assignees.push(volunteer.id);
    }
  }
  assignConflictingAvailability(conflicting);

  const roster: Roster = { assignments: [], vacancies: [] };
  for (const { shift, assignees } of shiftsById.values()) {
    for (const volunteerId of assignees) {
      roster.assignments.push({ volunteerId, shiftId: shift.id });
    }
    const count = shift.capacity - assignees.length;
    if (count > 0) roster.vacancies.push({ shiftId: shift.id, count });
  }
  return roster;
}
