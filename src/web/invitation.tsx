import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, ApiError, errorMessage, eventDate } from './api.ts';
import type { InvitationDetail } from '../event.ts';
import { firstOverlappingPair, shiftTimesOverlap } from '../shift-times.ts';
import { ConfirmAction } from './confirm-action.tsx';
import type { Confirmation } from './confirm-action.tsx';

export function Invitation({ path, sessionPanel, focusOnOpen = false }: { path: string; sessionPanel?: ReactNode; focusOnOpen?: boolean }) {
  const [detail, setDetail] = useState<InvitationDetail>();
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [returning, setReturning] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const actionHeading = useRef<HTMLHeadingElement>(null);
  const previousWithdrawal = useRef<boolean>(undefined);
  const isWithdrawn = detail?.withdrawn;

  useEffect(() => {
    let active = true;
    api<InvitationDetail>(path).then((data) => {
      if (!active) return;
      setDetail(data);
      setSelection(data.availableShiftIds);
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [path]);

  useEffect(() => {
    if (isWithdrawn === undefined) return;
    if (focusOnOpen || previousWithdrawal.current !== undefined && previousWithdrawal.current !== isWithdrawn) {
      actionHeading.current?.focus();
    }
    previousWithdrawal.current = isWithdrawn;
  }, [isWithdrawn, focusOnOpen]);

  function apply(data: InvitationDetail) {
    setDetail(data);
    setSelection(data.availableShiftIds);
    setReturning(false);
  }

  async function request(action: () => Promise<InvitationDetail>) {
    setChanging(true);
    setError('');
    try {
      apply(await action());
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          apply(await api<InvitationDetail>(path));
        } catch {
          // Keep the response error visible if the refresh also fails.
        }
      }
    } finally {
      setChanging(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void request(() => api<InvitationDetail>(`${path}/availability`, 'PUT', {
      shiftIds: selection, volunteerId: detail?.volunteer.id, revision: detail?.availabilityRevision,
    }));
  }

  function withdraw(published: boolean) {
    setConfirmation({
      title: 'Withdraw from this event?',
      description: published
        ? 'All your assigned slots will open. If you can make it again, reopen this link to restore your shifts.'
        : 'You’ll be removed from the active volunteer list. You can use this link to return while availability is open.',
      label: 'Withdraw from event',
      action: () => void request(() => api<InvitationDetail>(`${path}/withdraw`, 'POST', {
        volunteerId: detail?.volunteer.id, revision: detail?.rosterRevision, availabilityRevision: detail?.availabilityRevision,
      })),
    });
  }

  if (!detail) {
    return <main className="page narrow"><div className="card">
      <p role={error ? 'alert' : 'status'}>{error || 'Opening invitation…'}</p>
      {error && <div className="form-actions"><button disabled={changing} onClick={() => void request(() => api<InvitationDetail>(path))}>Try again</button></div>}
    </div>{error && sessionPanel}</main>;
  }

  const { event, volunteer, shifts, assignment, withdrawn, canRestoreAssignment, responded, availableShiftIds } = detail;
  // Older servers return a single assignment until they restart.
  const assignments = detail.assignments ?? (assignment ? [assignment] : []);
  const dirty = selection.length !== availableShiftIds.length || selection.some((id) => !availableShiftIds.includes(id));
  const overlapping = firstOverlappingPair(shifts);
  const selectedShifts = shifts.filter(({ id }) => selection.includes(id));
  const conflictingSelection = firstOverlappingPair(selectedShifts);
  return (
    <main className="page narrow">
      <div className="page-heading">
        <p className="date-line">{eventDate(event.date)}</p>
        <h1>{event.name}</h1>
        <p className="muted">Invitation for {volunteer.name}</p>
      </div>
      {error && <p role="alert" className="message error">{error}</p>}
      <section className="card" aria-labelledby="volunteer-action">
        {event.status === 'collecting' && withdrawn && !returning && (
          <>
            <h2 id="volunteer-action" ref={actionHeading} tabIndex={-1}>You’ve withdrawn</h2>
            <p className="muted">You’re no longer on the active volunteer list. If your plans change, you can send availability again.</p>
            <div className="form-actions"><button disabled={changing} onClick={() => { setError(''); setReturning(true); }}>Return to availability</button></div>
          </>
        )}
        {event.status === 'collecting' && (!withdrawn || returning) && (
          <>
            <h2 id="volunteer-action" ref={actionHeading} tabIndex={-1}>Your availability</h2>
            <p className="muted">Select the shifts you can work. You may be assigned more than one shift.</p>
            {overlapping && <p className="overlap-note">If two shifts overlap, choose one of them.</p>}
            {conflictingSelection && <p className="overlap-note" role="status">Uncheck {conflictingSelection[0].name} or {conflictingSelection[1].name} before saving.</p>}
            <p className={`response-note${dirty || returning ? ' unsaved' : ''}`} role="status">
              {dirty || returning ? 'Changes haven’t been saved.' : responded
                ? availableShiftIds.length ? 'Availability saved.' : 'Saved as unavailable.'
                : 'Awaiting your response.'}
            </p>
            <form onSubmit={save}>
              <fieldset className="shift-options" disabled={changing}>
                <legend className="sr-only">Available shifts</legend>
                {shifts.map((shift) => {
                  const checked = selection.includes(shift.id);
                  const conflict = checked ? undefined : selectedShifts.find((chosen) => shiftTimesOverlap(shift, chosen));
                  const labelId = `shift-${shift.id}`;
                  return (
                    <label className={`shift-option${conflict ? ' overlaps-selection' : ''}`} key={shift.id}>
                      <input
                        type="checkbox" checked={checked} disabled={Boolean(conflict)}
                        aria-labelledby={`${labelId}-name ${labelId}-time`}
                        aria-describedby={conflict ? `${labelId}-overlap` : undefined}
                        onChange={(input) => {
                          const checked = input.target.checked;
                          setSelection((current) => checked ? [...current, shift.id] : current.filter((id) => id !== shift.id));
                        }}
                      />
                      <span>
                        <strong id={`${labelId}-name`}>{shift.name}</strong>
                        <span className="muted" id={`${labelId}-time`}>{shift.startTime}–{shift.endTime}</span>
                        {conflict && <span className="overlap-reason" id={`${labelId}-overlap`}>Overlaps with {conflict.name}</span>}
                      </span>
                    </label>
                  );
                })}
                {shifts.length === 0 && <p className="muted">No shifts have been added yet.</p>}
              </fieldset>
              <div className="form-actions">
                <button disabled={changing || shifts.length === 0 || Boolean(conflictingSelection) || (responded && !dirty && !returning)}>
                  {selection.length === 0 ? 'Save as unavailable' : 'Save availability'}
                </button>
                {(dirty || returning) && <button type="button" className="secondary" disabled={changing} onClick={() => {
                  setSelection(availableShiftIds);
                  setReturning(false);
                  setError('');
                }}>Cancel changes</button>}
              </div>
            </form>
            {!returning && <div className="withdraw-action">
              <button className="plain" disabled={changing} onClick={() => withdraw(false)}>Withdraw from event</button>
            </div>}
          </>
        )}
        {event.status === 'published' && withdrawn && (
          <>
            <h2 id="volunteer-action" ref={actionHeading} tabIndex={-1}>You’ve withdrawn</h2>
            <p className="muted">{canRestoreAssignment
              ? 'If you can attend again, restore your original shifts here.'
              : 'Your withdrawal is recorded. Contact the organizer if your plans change.'}</p>
            {canRestoreAssignment && (
              <div className="form-actions">
                <button type="button" disabled={changing} onClick={() => void request(() =>
                  api<InvitationDetail>(`${path}/restore`, 'POST', {
                    volunteerId: volunteer.id, revision: detail.rosterRevision, availabilityRevision: detail.availabilityRevision,
                  }),
                )}>Restore my shifts</button>
              </div>
            )}
          </>
        )}
        {event.status === 'published' && !withdrawn && (
          <>
            <h2 id="volunteer-action" ref={actionHeading} tabIndex={-1}>Your shifts</h2>
            {assignments.length > 0 ? (
              <>
                {assignments.map((shift) => (
                  <div className="assignment" key={shift.id}>
                    <h3>{shift.name}</h3><p>{shift.startTime}–{shift.endTime}</p>
                  </div>
                ))}
                <div className="withdraw-action"><button className="plain" disabled={changing} onClick={() => withdraw(true)}>Withdraw from event</button></div>
              </>
            ) : <p className="muted">You weren’t assigned a shift for this event.</p>}
          </>
        )}
      </section>
      {sessionPanel}
      {confirmation && <ConfirmAction confirmation={confirmation} onDismiss={() => setConfirmation(undefined)} />}
    </main>
  );
}
