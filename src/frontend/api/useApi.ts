import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./client";

export type AsyncState<T> = {
  data: T | undefined;
  loading: boolean;
  error: ApiError | Error | undefined;
  reload: () => void;
  setData: (next: T | undefined) => void;
};

type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export function useApi<T>(fetcher: Fetcher<T>, deps: ReadonlyArray<unknown> = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);
    fetcherRef
      .current(controller.signal)
      .then((value) => {
        if (!active) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if ((err as DOMException)?.name === "AbortError") {
          return;
        }
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload, setData };
}

export function useInterval(callback: () => void, ms: number, enabled = true): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => cbRef.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}
