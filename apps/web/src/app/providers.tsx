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

/**
 * One cache per signed-in user. Query keys don't include the user, so on sign-out or an account
 * switch in the same tab the old cache is dropped instead of showing the previous user's data.
 */
function useQueryClientForUser(userId: string | null | undefined): QueryClient {
  const [cache, setCache] = useState(() => ({ userId, client: makeQueryClient() }));
  if (cache.userId !== userId) {
    // Adjusting state during render (React's pattern for "reset on prop change"): children never
    // render with the old user's cache, and the old client is dropped with its data.
    const next = { userId, client: makeQueryClient() };
    setCache(next);
    return next.client;
  }
  return cache.client;
}

export function Providers({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const queryClient = useQueryClientForUser(userId);
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
