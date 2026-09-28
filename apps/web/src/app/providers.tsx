'use client';

import { useAuth } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { createApiClient, isApiError, type ApiClient } from '@/lib/api';

const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error('useApi must be used inside <Providers>');
  return client;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Client errors (4xx) won't succeed on retry.
        retry: (failureCount, error) =>
          !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const { getToken } = useAuth();
  // Keep the client stable; always read the latest getToken.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const [apiClient] = useState(() =>
    createApiClient({
      baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
      getToken: () => getTokenRef.current(),
    }),
  );

  return (
    <ApiContext.Provider value={apiClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}
