import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadLanguage } from './i18n';
import './styles/index.css';
import { App } from './App';
import { ThemeProvider } from './lib/theme';
import { AuthProvider } from './auth/AuthProvider';
import { createAuthService } from './auth/createAuthService';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { isDemo } from './lib/config';
import { registerServiceWorker } from './lib/pwa';
import { AppChrome } from './components/layout/AppChrome';

// test-gateway checkout dialog (supabase mode only), loaded on demand
const MockCheckoutHost = React.lazy(() => import('./services/payments/mock').then((m) => ({ default: m.MockCheckoutHost })));

const authService = createAuthService();
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } });

registerServiceWorker();

const savedLanguage = (() => { try { return (JSON.parse(localStorage.getItem('scc-prefs') ?? '{}') as { language?: string }).language; } catch { return undefined; } })();
void (savedLanguage && savedLanguage !== 'en' ? loadLanguage(savedLanguage).catch(() => undefined) : Promise.resolve()).then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <BrowserRouter>
            <AuthProvider service={authService}>
              <AppChrome />
              <App />
              <Toaster />
              {!isDemo && <React.Suspense fallback={null}><MockCheckoutHost /></React.Suspense>}
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
));
