"use client";

import { useState, useEffect, useCallback } from "react";
import { apiGet, ApiError, getErrorMessage, isUnauthorizedError } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

interface UseFetchOptions<T> {
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  enabled?: boolean;
}

interface UseFetchResult<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<void>;
}

export function useFetch<T>(
  endpoint: string,
  options: UseFetchOptions<T> = {}
): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { logout } = useAuth();
  const { onSuccess, onError, enabled = true } = options;

  const fetchData = useCallback(async () => {
    if (!enabled) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await apiGet<T>(endpoint);
      setData(result);
      onSuccess?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);

      // Handle 401 - redirect to login
      if (isUnauthorizedError(err)) {
        logout();
      }
    } finally {
      setIsLoading(false);
    }
  }, [endpoint, enabled, onSuccess, onError, logout]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    error,
    isLoading,
    isError: !!error,
    refetch: fetchData,
  };
}

// Mutation hook for POST/PUT/DELETE operations
export function useMutation<TData, TVariables>() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (
      fn: (variables: TVariables) => Promise<TData>,
      variables: TVariables
    ): Promise<TData | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await fn(variables);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return { mutate, isLoading, error };
}