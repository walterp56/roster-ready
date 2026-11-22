import type { EventShift } from './event.ts';

type ShiftTimes = Pick<EventShift, 'startTime' | 'endTime'>;

export function shiftTimesOverlap(first: ShiftTimes, second: ShiftTimes): boolean {
  return first.startTime < second.endTime && second.startTime < first.endTime;
}

export function firstOverlappingPair<T extends ShiftTimes>(shifts: readonly T[]): [T, T] | undefined {
  const chronological = [...shifts].sort((left, right) => left.startTime.localeCompare(right.startTime));
  for (let index = 1; index < chronological.length; index++) {
    const previous = chronological[index - 1];
    const current = chronological[index];
    if (shiftTimesOverlap(previous, current)) return [previous, current];
  }
}
