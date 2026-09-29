'use client';

import { useAuth } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { createApiClient, isApiError, type ApiClient } from '@/lib/api';
import { nextUserCache, type UserCache } from '@/lib/user-cache';

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

/** One cache per signed-in user (see `nextUserCache`). */
function useQueryClientForUser(userId: string | null | undefined): UserCache<QueryClient> {
  const [cache, setCache] = useState<UserCache<QueryClient>>(() => ({
    userId,
    client: makeQueryClient(),
    generation: 0,
  }));
  const next = nextUserCache(cache, userId, makeQueryClient);
  if (next !== cache) {
    // Adjusting state during render (React's pattern for "reset on prop change"): children never
    // render with the previous user's cache.
    setCache(next);
  }
  return next;
}

export function Providers({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const { client: queryClient, generation } = useQueryClientForUser(userId);
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
      {/* useQuery binds to the client it first saw, so a new client needs a fresh subtree */}
      <QueryClientProvider key={generation} client={queryClient}>
        {children}
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}
