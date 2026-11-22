import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errorMessage, eventDate, statusLabel } from './api.ts';
import type { EventDetail, EventShift, EventSummary, EventVolunteer, OrganizerSession } from '../event.ts';
import { firstOverlappingPair } from '../shift-times.ts';
import { maxPasswordLength, minPasswordLength } from '../password-limits.ts';
import { ConfirmAction } from './confirm-action.tsx';
import type { Confirmation } from './confirm-action.tsx';

const rosterActions = {
  reopen: {
    title: 'Unpublish this roster?',
    description: 'This clears the roster and hides assignments. You can add shifts, and volunteers can sign up or update their saved responses through the same link.',
    label: 'Unpublish roster',
  },
  publish: {
    title: 'Publish this roster?',
    description: 'This creates the roster from saved responses and closes availability. Volunteers can see their own assignments through the event link.',
    label: 'Publish roster',
  },
};

function newCreationRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function Organizer() {
  const [auth, setAuth] = useState<OrganizerSession>();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [current, setCurrent] = useState<EventDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState(false);
  const pendingEvent = useRef<{ payload: string; requestId: string }>(null);

  useEffect(() => {
    void perform(loadWorkspace);
  }, []);

  async function loadWorkspace() {
    pendingEvent.current = null;
    setAuth(undefined);
    setEvents([]);
    setCurrent(undefined);
    setCreating(false);
    const session = await api<OrganizerSession>('/organizer/session');
    if (session.account) await loadEvents();
    setAuth(session);
  }

  async function loadEvents() {
    const { events } = await api<{ events: EventSummary[] }>('/events');
    setEvents(events);
    setCurrent(events.length > 0 ? await api<EventDetail>(`/events/${events[0].id}`) : undefined);
  }

  async function perform(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function updateEvent(detail: EventDetail) {
    setCurrent(detail);
    const { id, name, date, status } = detail;
    setEvents((list) => list.some((event) => event.id === id)
      ? list.map((event) => event.id === id ? { id, name, date, status } : event)
      : [{ id, name, date, status }, ...list]);
  }

  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = data.get('username');
    const password = data.get('password');
    if (registering && password !== data.get('confirm-password')) {
      setError('The passwords do not match.');
      return;
    }
    const path = registering ? '/organizer/accounts' : '/organizer/session';
    void perform(async () => {
      setAuth(await api<OrganizerSession>(path, 'POST', { username, password }));
      setRegistering(false);
      await loadEvents();
    });
  }

  function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const organizerId = auth?.account?.id;
    const form = event.currentTarget;
    const data = new FormData(form);
    const details = { organizerId, name: data.get('name'), date: data.get('date') };
    void perform(async () => {
      try {
        const payload = JSON.stringify(details);
        if (pendingEvent.current?.payload !== payload) {
          pendingEvent.current = { payload, requestId: newCreationRequestId() };
        }
        updateEvent(await api<EventDetail>('/events', 'POST', { ...details, requestId: pendingEvent.current.requestId }));
      } catch (reason) {
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 409)) {
          await loadWorkspace();
        }
        throw reason;
      }
      pendingEvent.current = null;
      form.reset();
      setCreating(false);
    });
  }

  if (!auth) {
    return <main className="page narrow"><div className="card">
      <p role={error ? 'alert' : 'status'}>{error || 'Opening organizer workspace…'}</p>
      {error && <div className="form-actions"><button disabled={busy} onClick={() => void perform(loadWorkspace)}>Try again</button></div>}
    </div></main>;
  }

  if (!auth.account) {
    return (
      <main className="page narrow">
        <section className="card login" aria-labelledby="organizer-access">
          <h1 id="organizer-access">{registering ? 'Create an organizer account' : 'Organizer sign-in'}</h1>
          <p className="muted">{registering ? 'Choose a username and password for your events.' : 'Sign in to manage your events and rosters.'}</p>
          <form className="stack" key={String(registering)} onSubmit={authenticate}>
            <label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={40} required /></label>
            {registering && <p className="muted form-hint">Use 3 to 40 letters, numbers, dots, hyphens or underscores. Start with a letter or number.</p>}
            <label>Password<input name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'}
              aria-describedby={registering ? 'organizer-password-rules' : undefined} required /></label>
            {registering && <label>Confirm password<input name="confirm-password" type="password" autoComplete="new-password" required /></label>}
            {registering && <p className="muted form-hint" id="organizer-password-rules">Use {minPasswordLength} to {maxPasswordLength} characters. A passphrase with spaces works well.</p>}
            {error && <p className="message error" role="alert">{error}</p>}
            <button disabled={busy}>{registering ? 'Create organizer account' : 'Sign in'}</button>
          </form>
          <div className="form-actions"><button className="secondary" type="button" disabled={busy} onClick={() => {
            setError('');
            setRegistering(!registering);
          }}>{registering ? 'Back to sign in' : 'Create an account'}</button></div>
        </section>
      </main>
    );
  }

  return (
    <main className="page organizer">
      <aside className="sidebar">
        <section className="card" aria-labelledby="event-list">
          <div className="section-heading">
            <h2 id="event-list">Events</h2>
            <button className="plain" type="button" disabled={busy} onClick={() => void perform(async () => {
              await api('/organizer/session', 'DELETE');
              pendingEvent.current = null;
              setAuth({ account: null });
              setCurrent(undefined);
              setEvents([]);
              setCreating(false);
            })}>Sign out</button>
          </div>
          <p className="muted">Signed in as {auth.account.username}</p>
          <nav className="event-nav" aria-label="Events">
            {events.map((event) => (
              <button
                type="button" className="event-link" aria-current={event.id === current?.id ? 'true' : undefined}
                disabled={busy} key={event.id}
                onClick={() => void perform(async () => setCurrent(await api<EventDetail>(`/events/${event.id}`)))}
              >
                <strong>{event.name}</strong><span>{eventDate(event.date)}</span>
              </button>
            ))}
            {events.length === 0 && <p className="muted">Your events will appear here.</p>}
          </nav>
        </section>
        {creating || events.length === 0 ? (
          <section className="card" aria-labelledby="new-event">
            <h2 id="new-event">New event</h2>
            <form className="stack" onSubmit={createEvent}>
              <label>Event name<input name="name" required maxLength={100} /></label>
              <label>Event date<input name="date" required type="date" /></label>
              <div className="event-form-actions">
                <button disabled={busy}>Create event</button>
                {events.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => {
                  pendingEvent.current = null;
                  setCreating(false);
                }}>Cancel</button>}
              </div>
            </form>
          </section>
        ) : <button className="secondary" type="button" disabled={busy} onClick={() => setCreating(true)}>New event</button>}
      </aside>
      <div className="workspace">
        {error && <p className="message error" role="alert">{error}</p>}
        {current ? (
          <EventWorkspace key={current.id} event={current} busy={busy} perform={perform} updateEvent={updateEvent} />
        ) : (
          <div className="card empty-workspace">
            <h1>{busy ? 'Opening events…' : 'Create your first event'}</h1>
            <p className="muted">Choose a date to start adding shifts and inviting volunteers.</p>
          </div>
        )}
      </div>
    </main>
  );
}

function EventWorkspace({ event, busy, perform, updateEvent }: {
  event: EventDetail;
  busy: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
  updateEvent: (event: EventDetail) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [editingShift, setEditingShift] = useState<EventShift>();
  const editButton = useRef<HTMLButtonElement>(null);
  const shiftsHeading = useRef<HTMLHeadingElement>(null);
  const rosterHeading = useRef<HTMLHeadingElement>(null);
  const pendingShift = useRef<{ payload: string; requestId: string }>(null);
  const previousStatus = useRef(event.status);
  const path = `/events/${event.id}`;
  const groupLink = new URL(`/join/${event.id}`, window.location.origin).href;
  const published = event.status === 'published';
  const total = event.shifts.reduce((count, shift) => count + BigInt(shift.capacity), 0n);
  const assigned = new Set(event.roster?.assignments.map(({ volunteerId }) => volunteerId));
  const shiftLabels = new Map(event.shifts.map(({ id, name, startTime, endTime }) => [id, `${name} (${startTime}–${endTime})`]));
  const availableCounts = new Map<string, number>();
  const activeVolunteers = event.volunteers.filter(({ withdrawn }) => !withdrawn).map((volunteer) => {
    const availableShifts: string[] = [];
    if (volunteer.responded) {
      for (const shiftId of volunteer.availableShiftIds) {
        const label = shiftLabels.get(shiftId);
        if (label === undefined) continue;
        availableShifts.push(label);
        availableCounts.set(shiftId, (availableCounts.get(shiftId) ?? 0) + 1);
      }
    }
    return { ...volunteer, availableShifts };
  });

  useEffect(() => {
    if (previousStatus.current === event.status) return;
    previousStatus.current = event.status;
    editButton.current = null;
    setEditingShift(undefined);
    rosterHeading.current?.focus();
  }, [event.status]);

  useEffect(() => {
    if (editingShift || busy || !editButton.current) return;
    const target = editButton.current.isConnected ? editButton.current : shiftsHeading.current;
    editButton.current = null;
    target?.focus();
  }, [editingShift, busy]);

  async function refresh() {
    updateEvent(await api<EventDetail>(path));
  }

  function saveShift(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const form = submission.currentTarget;
    const data = new FormData(form);
    const shift = {
      name: data.get('name'), capacity: Number(data.get('capacity')),
      startTime: data.get('startTime'), endTime: data.get('endTime'),
    };

    function save(confirmTimeChange = false) {
      void perform(async () => {
        if (editingShift) {
          try {
            updateEvent(await api<EventDetail>(`${path}/shifts/${editingShift.id}`, 'PUT', { ...shift, previous: editingShift, confirmTimeChange }));
            setEditingShift(undefined);
          } catch (reason) {
            if (reason instanceof ApiError && (reason.status === 409 || reason.status === 404)) {
              setEditingShift(undefined);
              await refresh();
            }
            throw reason;
          }
        } else {
          const payload = JSON.stringify(shift);
          if (pendingShift.current?.payload !== payload) {
            pendingShift.current = { payload, requestId: newCreationRequestId() };
          }
          updateEvent(await api<EventDetail>(`${path}/shifts`, 'POST', { ...shift, requestId: pendingShift.current.requestId }));
          pendingShift.current = null;
          form.reset();
        }
      });
    }

    if (editingShift && (shift.startTime !== editingShift.startTime || shift.endTime !== editingShift.endTime)) {
      setConfirmation({
        title: 'Change the shift time?',
        description: 'Volunteers who selected this shift will need to select the new time through the event link. Their choices for other shifts stay saved.',
        label: 'Save new time',
        action: () => save(true),
      });
      return;
    }
    save();
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(groupLink);
      setCopyStatus('Event link copied.');
    } catch {
      setCopyStatus('Select the link and copy it manually.');
    }
  }

  function decideRosterAction(action: keyof typeof rosterActions) {
    setConfirmation({
      ...rosterActions[action],
      action: () => void perform(async () => {
        try {
          const body = action === 'reopen' ? { revision: event.rosterRevision } : undefined;
          updateEvent(await api<EventDetail>(`${path}/${action}`, 'POST', body));
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 409) await refresh();
          throw reason;
        }
      }),
    });
  }

  function decideWithdrawal(volunteer: EventVolunteer) {
    setConfirmation({
      title: `Record ${volunteer.name}’s withdrawal?`,
      description: event.status === 'published'
        ? 'All their assigned slots will open. They can restore their shifts from the event link.'
        : 'They’ll be skipped when you publish the roster.',
      label: 'Record withdrawal',
      action: () => void perform(async () => {
        try {
          updateEvent(await api<EventDetail>(`${path}/volunteers/${volunteer.id}/withdrawal`, 'PUT', {
            withdrawn: true, revision: event.rosterRevision, availabilityRevision: volunteer.availabilityRevision,
          }));
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 409) await refresh();
          throw reason;
        }
      }),
    });
  }

  const rosterGuidance = published
    ? 'Volunteers can see their own shifts through the event link. Record a withdrawal under Volunteers to free that person’s slots.'
    : 'Volunteers can sign up and update their responses. Publishing closes availability.';

  return (
    <>
      <div className="event-heading">
        <div className="page-heading"><p className="date-line">{eventDate(event.date)}</p><h1>{event.name}</h1></div>
        <span className={`badge ${event.status}`} role="status">{statusLabel[event.status]}</span>
      </div>
      <section className="card roster-card" aria-labelledby="roster">
        <div className="section-heading">
          <h2 id="roster" ref={rosterHeading} tabIndex={-1}>Roster</h2>
          {published ? (
            <div className="roster-actions">
              <button className="plain" type="button" disabled={busy} onClick={() => void perform(refresh)}>Refresh roster</button>
              <button className="secondary" disabled={busy} type="button"
                onClick={() => decideRosterAction('reopen')}>{rosterActions.reopen.label}</button>
            </div>
          ) : (
            <button disabled={busy || !event.shifts.length || Boolean(editingShift)} type="button" aria-describedby="roster-guidance"
              onClick={() => decideRosterAction('publish')}>{rosterActions.publish.label}</button>
          )}
        </div>
        <p className="muted" id="roster-guidance">
          {editingShift ? 'Save or cancel the shift edit before publishing.' : event.shifts.length ? rosterGuidance : 'Add a shift before publishing.'}
        </p>
        {event.roster && <RosterReview event={event} total={total} volunteers={activeVolunteers} />}
      </section>
      <section className="card" aria-labelledby="shifts">
        <div className="section-heading"><h2 id="shifts" ref={shiftsHeading} tabIndex={-1}>Shifts</h2><span className="muted">{total.toString()} {total === 1n ? 'slot' : 'slots'}</span></div>
        {firstOverlappingPair(event.shifts) && <p className="overlap-note">These shifts include overlapping times. Volunteers must choose between shifts that overlap.</p>}
        {event.shifts.length > 0 && (
          <ul className="data-list">
            {event.shifts.map((shift) => {
              const available = availableCounts.get(shift.id) ?? 0;
              return (
                <li key={shift.id}>
                  <div className="shift-detail">
                    <strong>{shift.name}</strong>
                    <span>{shift.startTime}–{shift.endTime}</span>
                  </div>
                  <div className="shift-staffing">
                    <span><strong>{available}</strong> {available === 1 ? 'volunteer' : 'volunteers'} available</span>
                    <span>{shift.capacity} needed</span>
                  </div>
                  {!published && (
                    <button className="plain shift-edit" type="button" disabled={busy}
                      aria-label={`Edit ${shift.name}, ${shift.startTime}–${shift.endTime}`} onClick={(event) => {
                        editButton.current = event.currentTarget;
                        setEditingShift(shift);
                      }}>Edit</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!published && (
          <>
            {editingShift && <p className="muted form-hint">Editing <strong>{editingShift.name}</strong></p>}
            <form className="shift-form" key={editingShift?.id ?? 'add-shift'} onSubmit={saveShift}>
              <label>Shift name<input name="name" defaultValue={editingShift?.name} autoFocus={Boolean(editingShift)} required maxLength={100} /></label>
              <label>Start time<input name="startTime" defaultValue={editingShift?.startTime} type="time" required /></label>
              <label>End time<input name="endTime" defaultValue={editingShift?.endTime} type="time" required /></label>
              <label>Volunteers needed<input name="capacity" type="number" min="1" step="1" defaultValue={editingShift?.capacity ?? 1} required /></label>
              <div className="event-form-actions">
                <button disabled={busy}>{editingShift ? 'Save shift' : 'Add shift'}</button>
                {editingShift && <button className="secondary" type="button" disabled={busy} onClick={() => setEditingShift(undefined)}>Cancel</button>}
              </div>
            </form>
          </>
        )}
      </section>
      <section className="card" aria-labelledby="share-event">
        <h2 id="share-event">Share event</h2>
        <p className="muted">{published ? 'Volunteers can return to their own response using this same link.' : 'Anyone with this link can sign up and submit their availability.'}</p>
        <div className="inline-form">
          <input type="url" value={groupLink} readOnly aria-label="Shared event link" onFocus={(input) => input.target.select()} />
          <button className="secondary" type="button" onClick={() => void copyLink()}>Copy link</button>
        </div>
        {copyStatus && <p className="form-hint" role="status">{copyStatus}</p>}
      </section>
      <section className="card" aria-labelledby="volunteers">
        <div className="section-heading">
          <h2 id="volunteers">Volunteers</h2>
          <div className="response-count">
            {activeVolunteers.length > 0 && <span className="muted">{activeVolunteers.filter((volunteer) => volunteer.responded).length} of {activeVolunteers.length} responded</span>}
            {!published && <button className="plain" type="button" disabled={busy} onClick={() => void perform(refresh)}>Refresh responses</button>}
          </div>
        </div>
        {activeVolunteers.length > 0 ? (
          <ul className="volunteer-list">
            {activeVolunteers.map((volunteer) => (
              <li key={volunteer.id}>
                <div className="section-heading">
                  <strong>{volunteer.name}</strong>
                  <div className="response-count">
                    {volunteer.availableShifts.length === 0 && (
                      <span className="response-badge">{volunteer.responded ? 'Unavailable' : 'Awaiting response'}</span>
                    )}
                    {(!published || assigned.has(volunteer.id)) && (
                      <button className="plain" type="button" disabled={busy} onClick={() => decideWithdrawal(volunteer)}
                        aria-label={`Record withdrawal for ${volunteer.name}`}>
                        Record withdrawal
                      </button>
                    )}
                  </div>
                </div>
                {volunteer.availableShifts.length > 0 && (
                  <p className="muted volunteer-availability">Available for <strong>{volunteer.availableShifts.join(', ')}</strong></p>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted form-hint">There are no active volunteers.</p>}
      </section>
      {confirmation && <ConfirmAction confirmation={confirmation} onDismiss={() => setConfirmation(undefined)} />}
    </>
  );
}

function RosterReview({ event, total, volunteers }: { event: EventDetail; total: bigint; volunteers: readonly EventVolunteer[] }) {
  const roster = event.roster!;
  const namesById = new Map(volunteers.map(({ id, name }) => [id, name]));
  const rows = event.shifts.map((shift) => {
    const names: string[] = [];
    for (const assignment of roster.assignments.filter(({ shiftId }) => shiftId === shift.id)) {
      const name = namesById.get(assignment.volunteerId);
      if (name !== undefined) names.push(name);
    }
    return { shift, names, open: shift.capacity - names.length };
  });
  const filled = rows.reduce((count, row) => count + row.names.length, 0);
  const open = total - BigInt(filled);
  return (
    <>
      <div className={`roster-summary${open ? ' has-vacancies' : ''}`} role="status">
        <strong>{filled} of {total.toString()} slots filled</strong><span>{open.toString()} {open === 1n ? 'vacancy' : 'vacancies'}</span>
      </div>
      <table>
        <thead><tr><th scope="col">Shift</th><th scope="col">Assigned volunteers</th><th scope="col">Open</th></tr></thead>
        <tbody>{rows.map(({ shift, names, open }) => (
          <tr key={shift.id}>
            <th scope="row">{shift.name}</th>
            <td>{names.join(', ') || '—'}</td>
            <td>{open}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}
