import { createRoot } from 'react-dom/client';
import { Organizer } from './organizer.tsx';
import { Invitation } from './invitation.tsx';
import { SharedInvitation } from './shared-invitation.tsx';
import './style.css';

const invitation = /^\/invite\/([^/]+)$/.exec(window.location.pathname);
const signup = /^\/join\/([^/]+)$/.exec(window.location.pathname);

function App() {
  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <span className="brand"><span className="brand-icon" aria-hidden="true">✓</span>Roster<span>Ready</span></span>
          <span className="workspace-label">{invitation || signup ? 'Volunteer invitation' : 'Organizer workspace'}</span>
        </div>
      </header>
      {signup ? <SharedInvitation eventId={signup[1]} /> : invitation ? <Invitation path={`/invitations/${invitation[1]}`} /> : <Organizer />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
