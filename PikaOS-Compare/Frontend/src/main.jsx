import { createRoot } from 'react-dom/client';
import './styles/index.css';

// side-effect modules: i18n registry (import.meta.glob scan) + the imperative modal/loading
// hosts that set window.uiConfirm / window.uiLoading (used by the Compare screen).
import './lib/i18n.jsx';
import './lib/ui-modal.jsx';
import App from './App.jsx';

// restore saved theme (pro | pro-dark) before first paint
try {
  const t = localStorage.getItem('guild-theme');
  if (t === 'pro' || t === 'pro-dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}

createRoot(document.getElementById('root')).render(<App />);
