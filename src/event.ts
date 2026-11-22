import type { Roster } from './scheduler.ts';

export type OrganizerAccount = { id: string; username: string };

export type OrganizerSession = {
  account: OrganizerAccount | null;
};

export type EventSummary = {
  id: string;
  name: string;
  date: string;
  status: 'collecting' | 'published';
};

export type EventShift = {
  id: string;
  name: string;
  capacity: number;
  startTime: string;
  endTime: string;
};

export type EventVolunteer = {
  id: string;
  name: string;
  responded: boolean;
  withdrawn: boolean;
  availabilityRevision: string;
  availableShiftIds: string[];
};

export type EventDetail = EventSummary & {
  shifts: EventShift[];
  volunteers: EventVolunteer[];
  roster: Roster | null;
  rosterRevision: string | null;
};

export type SignupPage = {
  event: EventSummary;
  signedIn: boolean;
};

export type InvitationDetail = {
  event: EventSummary;
  volunteer: { id: string; name: string };
  shifts: EventShift[];
  availableShiftIds: string[];
  availabilityRevision: string;
  responded: boolean;
  withdrawn: boolean;
  canRestoreAssignment: boolean;
  rosterRevision: string | null;
  assignments: EventShift[];
  assignment: EventShift | null;
};
