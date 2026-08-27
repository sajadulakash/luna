import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { installOwnerAuth } from './stores/authStore';
import './index.css';

// Wires the auth store into the fetch wrapper before anything renders.
installOwnerAuth();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Meetings change underneath us when Luna books something, but that
      // arrives as a `meetings_changed` event rather than as polling.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
