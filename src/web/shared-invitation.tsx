import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SignupPage } from '../event.ts';
import { api, ApiError, errorMessage, eventDate } from './api.ts';
import { Invitation } from './invitation.tsx';

export function SharedInvitation({ eventId }: { eventId: string }) {
  const path = `/join/${eventId}`;
  const attemptKey = `roster-ready-signup:${eventId}`;
  const [page, setPage] = useState<SignupPage>();
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [attempt, setAttempt] = useState(() => {
    try {
      const saved = sessionStorage.getItem(attemptKey);
      return saved && /^[0-9a-f]{64}$/.test(saved) ? saved : undefined;
    } catch {
      return undefined;
    }
  });

  useEffect(() => {
    loadEvent();
  }, [path]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function loadEvent() {
    void perform(async () => {
      const page = await api<SignupPage>(path);
      if (page.signedIn) clearAttempt();
      setPage(page);
    });
  }

  function createAttempt() {
    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    setAttempt(value);
    try { sessionStorage.setItem(attemptKey, value); } catch { /* Storage can be disabled. */ }
    return value;
  }

  function clearAttempt() {
    setAttempt(undefined);
    try { sessionStorage.removeItem(attemptKey); } catch { /* Storage can be disabled. */ }
  }

  function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void perform(async () => {
      const signupAttempt = attempt ?? (page?.event.status === 'collecting' ? createAttempt() : undefined);
      if (!signupAttempt) return;
      try {
        const { code } = await api<{ code: string }>(path, 'POST', { name, signupAttempt });
        clearAttempt();
        setCode(code);
        setFocusOnOpen(true);
        setPage((current) => current && { ...current, signedIn: true });
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 409) {
          const latest = await api<SignupPage>(path);
          if (latest.signedIn || latest.event.status === 'published') clearAttempt();
          setPage(latest);
        }
        throw reason;
      }
    });
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    void perform(async () => {
      await api(`${path}/session`, 'POST', { code });
      clearAttempt();
      setFocusOnOpen(true);
      setPage((current) => current && { ...current, signedIn: true });
    });
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus('Recovery code copied.');
    } catch {
      setCopyStatus('Select the recovery code and copy it manually.');
    }
  }

  if (!page) return (
    <main className="page narrow">
      <section className="card">
        <p role={error ? 'alert' : 'status'}>{error || 'Opening event…'}</p>
        {error && <div className="form-actions"><button type="button" disabled={busy} onClick={loadEvent}>Try again</button></div>}
      </section>
    </main>
  );

  if (page.signedIn) {
    const sessionPanel = (
      <section className="card volunteer-session" aria-labelledby="return-access">
        <div className="section-heading">
          <h2 id="return-access">Returning later</h2>
          <button className="plain" type="button" disabled={busy} onClick={() => void perform(async () => {
            await api(`${path}/session`, 'DELETE');
            clearAttempt();
            setCode('');
            setCopyStatus('');
            setRecovering(true);
            setPage(await api<SignupPage>(path));
          })}>Switch volunteer</button>
        </div>
        <p className="muted">This browser remembers you. Use your private recovery code to open your response on another device.</p>
        {code ? (
          <>
            <div className="inline-form">
              <input type="text" value={code} aria-label="Your recovery code" readOnly onFocus={(event) => event.target.select()} />
              <button className="secondary" type="button" onClick={() => void copyCode()}>Copy code</button>
            </div>
            {copyStatus && <p className="form-hint" role="status">{copyStatus}</p>}
          </>
        ) : <div className="form-actions"><button className="secondary" type="button" disabled={busy} onClick={() => void perform(async () => {
          setCode((await api<{ code: string }>(`${path}/recovery-code`)).code);
        })}>Show recovery code</button></div>}
        {error && <p className="message error" role="alert">{error}</p>}
      </section>
    );
    return <Invitation path={`${path}/volunteer`} sessionPanel={sessionPanel} focusOnOpen={focusOnOpen} />;
  }

  const collecting = page.event.status === 'collecting';
  return (
    <main className="page narrow">
      <div className="page-heading">
        <p className="date-line">{eventDate(page.event.date)}</p>
        <h1>{page.event.name}</h1>
      </div>
      <section className="card" aria-labelledby="sign-up-heading">
        <h2 id="sign-up-heading">{recovering ? 'Open your response' : collecting ? 'Sign up to volunteer' : 'Sign-ups are closed'}</h2>
        {error && <p className="message error" role="alert">{error}</p>}
        {recovering ? (
          <form className="stack" key="recover" onSubmit={signIn}>
            <label>Recovery code<input type="password" name="code" autoComplete="off" spellCheck={false} autoFocus required /></label>
            <button disabled={busy}>Open my response</button>
          </form>
        ) : collecting || attempt ? (
          <form className="stack" key="signup" onSubmit={signUp}>
            {!collecting && <p className="muted">Enter your name to retry the sign-up you started on this browser.</p>}
            <label>Your name<input name="name" autoComplete="name" required maxLength={120} /></label>
            <button disabled={busy}>{collecting ? 'Sign up' : 'Retry signup'}</button>
          </form>
        ) : <p className="muted">If you’ve already signed up, use your recovery code to view your response.</p>}
        <div className="form-actions">
          <button className="secondary" type="button" disabled={busy} onClick={() => { setError(''); setRecovering(!recovering); }}>
            {recovering ? 'Back' : 'Use recovery code'}
          </button>
        </div>
      </section>
    </main>
  );
}
