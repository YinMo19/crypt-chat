import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { Landing } from './pages/Landing';
import { Room } from './pages/Room';

function App() {
  const [nickname, setNickname] = React.useState('');
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing onEnter={setNickname} />} />
        <Route path="/r/:roomId" element={<Room nickname={nickname} />} />
      </Routes>
    </BrowserRouter>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
let departed = false;

// A page kept in the back/forward cache must not retain a live chat UI.
window.addEventListener('pagehide', () => {
  departed = true;
  root.unmount();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

function cleanupNotice(message: string) {
  if (!departed) root.render(<p role="alert" className="p-6">{message}</p>);
}

// Upgrade cleanup only: never open, read, or recreate the old message store.
async function clearLegacyStorage(): Promise<void> {
  sessionStorage.removeItem('nickname');
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('crypt-chat');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => cleanupNotice(
      'Close all other crypt-chat tabs to delete saved chat history. This page will continue once deletion completes.',
    );
  });
}

cleanupNotice('Removing saved data from older versions…');
void clearLegacyStorage().then(
  () => {
    if (!departed) root.render(<React.StrictMode><App /></React.StrictMode>);
  },
  () => cleanupNotice(
    'Could not delete saved chat history. Clear this site’s data in browser settings, then reload before chatting.',
  ),
);
