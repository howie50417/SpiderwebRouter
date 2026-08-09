import '@scalar/api-reference-react/style.css';
import 'antd/dist/reset.css';
import '@/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import { AppSettingsProvider } from '@/context/AppSettings';

const root = document.getElementById('root');
if (!root) throw new Error('Application root was not found');

createRoot(root).render(
  <StrictMode>
    <AppSettingsProvider>
      <App />
    </AppSettingsProvider>
  </StrictMode>,
);
