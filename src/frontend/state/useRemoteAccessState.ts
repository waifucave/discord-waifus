import { useCallback, useEffect, useMemo, useState } from "react";
import { api, openEventStream } from "../api/client";
import type { ClientContext, RemoteAccessStatus } from "../api/types";
import { RemoteAccessStore, type RemoteAccessStoreState } from "./remoteAccessStore";

export type RemoteAccessAsyncState = {
  data: RemoteAccessStatus | undefined;
  loading: boolean;
  error: Error | undefined;
  reload: () => void;
  setData: (next: RemoteAccessStatus | undefined) => void;
};

export function useRemoteAccessState(context: ClientContext): RemoteAccessAsyncState {
  const store = useMemo(() => new RemoteAccessStore((signal) => api.remoteAccessStatus(signal)), []);
  const [state, setState] = useState<RemoteAccessStoreState>(store.get());
  const contextKey = context.mode === "host" ? "host" : `remote:${context.selectedHostId}`;

  useEffect(() => {
    const unsubscribe = store.subscribe(setState);
    store.start(context, (options) => openEventStream(options));
    const poll = window.setInterval(() => void store.refresh(context), 5_000);
    return () => {
      window.clearInterval(poll);
      store.stop();
      unsubscribe();
    };
  }, [contextKey, store]);

  const reload = useCallback(() => void store.refresh(context), [contextKey, store]);
  const setData = useCallback((next: RemoteAccessStatus | undefined) => {
    if (next) store.applySnapshot(context, next);
  }, [contextKey, store]);

  return {
    data: state.status,
    loading: state.loading,
    error: state.error ? new Error(state.error) : undefined,
    reload,
    setData
  };
}
