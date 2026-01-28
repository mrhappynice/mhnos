import { createRoot } from 'react-dom/client';
import App from './components/App.js';

export function mount() {
  const root = createRoot(document.getElementById('root'));
  root.render(<App />);
}
