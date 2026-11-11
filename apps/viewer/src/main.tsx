import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer';
import './viewer.css';

function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <Viewer hash={hash} apiUrl={import.meta.env.VITE_BI_API_URL ?? '/bi-api'} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
