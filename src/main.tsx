import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import MobileApp from './MobileApp';
import { AuthGate } from './AuthGate';
import { pickMobileUI } from './utils/pickMobileUI';

// Which React tree mounts (desktop App vs mobile drill-down) is decided once at
// startup; the selection rules and their precedence live with the function in
// ./utils/pickMobileUI.
const isMobile = pickMobileUI();

// AuthGate wraps both trees: in browser mode it holds the app back until the
// server says this browser is authorized, and shows the login form when the
// workspace has a `##rysh web auth` login and our token is missing or expired.
// In Electron it is a pass-through.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{isMobile ? <MobileApp /> : <App />}</AuthGate>
  </StrictMode>
);
