import { useEffect, useId, useRef } from 'react';

export type Confirmation = {
  title: string;
  description: string;
  label: string;
  action: () => void;
};

export function ConfirmAction({ confirmation, onDismiss }: { confirmation: Confirmation; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog ref={dialog} className="confirmation" aria-labelledby={heading} aria-describedby={description} onClose={onDismiss}>
      <h2 id={heading}>{confirmation.title}</h2>
      <p className="muted" id={description}>{confirmation.description}</p>
      <form method="dialog" className="form-actions">
        <button className="secondary" autoFocus>Cancel</button>
        <button type="button" onClick={() => {
          dialog.current?.close();
          confirmation.action();
        }}>{confirmation.label}</button>
      </form>
    </dialog>
  );
}
