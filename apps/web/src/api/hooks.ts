import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

import { getSafeError, type ApiError } from '@/api/client';

export function useApiResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: DependencyList = [],
  enabled = true,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(enabled);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    loader(controller.signal)
      .then((result) => {
        if (mounted.current && !controller.signal.aborted) setData(result);
      })
      .catch((reason: unknown) => {
        if (mounted.current && !controller.signal.aborted) {
          setError(getSafeError(reason));
        }
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });

    return () => {
      mounted.current = false;
      controller.abort();
    };
    // The caller controls the dependency list just like useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, version, ...dependencies]);

  return { data, error, loading, refresh };
}

export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError>();

  const run = useCallback(
    async (...args: TArgs) => {
      setLoading(true);
      setError(undefined);
      try {
        return await action(...args);
      } catch (reason) {
        const safeError = getSafeError(reason);
        setError(safeError);
        throw safeError;
      } finally {
        setLoading(false);
      }
    },
    [action],
  );

  return { run, loading, error };
}
