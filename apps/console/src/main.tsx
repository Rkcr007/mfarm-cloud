import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import { App } from './app/App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('no #root — index.html and main.tsx disagree');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
