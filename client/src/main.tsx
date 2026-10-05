import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './App';
import { AuthProvider } from './features/auth/auth-context';
import { ApiError } from './lib/api';
import { useTheme } from './lib/theme';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retrying a 4xx never helps; only retry network and server errors.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

/** Applies the saved or system theme before anything renders. */
function ThemeRoot() {
  useTheme();
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeRoot />
        <App />
        <Toaster richColors position="bottom-right" closeButton />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
