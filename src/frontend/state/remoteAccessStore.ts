import type { ClientContext, RemoteAccessStatus } from "../api/types";
import type { FeedReset, ResumableEvent, ResumableEventFeed } from "../api/resumableEventFeed";

export type RemoteAccessStoreState = Readonly<{
  contextKey: string;
  sourceEpoch: number;
  dashboardBuildId: string | undefined;
  loading: boolean;
  status: RemoteAccessStatus | undefined;
  error: string | undefined;
}>;

export type RemoteAccessLoader = (signal: AbortSignal) => Promise<RemoteAccessStatus>;
type Listener = (state: RemoteAccessStoreState) => void;

export type RemoteAccessFeedOpener = (options: {
  onReset: (reset: FeedReset) => void | Promise<void>;
  onEvent: (event: ResumableEvent) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}) => ResumableEventFeed;

function clientContextKey(context: ClientContext): string {
  return context.mode === "host" ? "host" : `remote:${context.selectedHostId}`;
}

function initialState(): RemoteAccessStoreState {
  return Object.freeze({
    contextKey: "",
    sourceEpoch: 0,
    dashboardBuildId: undefined,
    loading: false,
    status: undefined,
    error: undefined
  });
}

/**
 * Owns the authoritative remote-access snapshot for exactly one selected host/dashboard build.
 * Stale requests are aborted and also generation-checked so late promises cannot cross hosts.
 */
export class RemoteAccessStore {
  readonly #load: RemoteAccessLoader;
  readonly #listeners = new Set<Listener>();
  #state = initialState();
  #requestGeneration = 0;
  #request: AbortController | undefined;
  #streamGeneration = 0;
  #feed: ResumableEventFeed | undefined;
  #feedContextKey: string | undefined;

  constructor(load: RemoteAccessLoader) {
    this.#load = load;
  }

  get(): RemoteAccessStoreState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setContext(context: ClientContext): void {
    const contextKey = clientContextKey(context);
    if (contextKey === this.#state.contextKey) return;
    this.#streamGeneration += 1;
    this.#feed?.close();
    this.#feed = undefined;
    this.#feedContextKey = undefined;
    this.#request?.abort();
    this.#request = undefined;
    this.#requestGeneration += 1;
    this.#state = Object.freeze({
      contextKey,
      sourceEpoch: this.#state.sourceEpoch + 1,
      dashboardBuildId: undefined,
      loading: false,
      status: undefined,
      error: undefined
    });
    this.#emit();
  }

  start(context: ClientContext, openFeed: RemoteAccessFeedOpener): void {
    this.setContext(context);
    const contextKey = clientContextKey(context);
    if (this.#feed && this.#feedContextKey === contextKey) return;
    this.#feed?.close();
    const generation = ++this.#streamGeneration;
    this.#feedContextKey = contextKey;
    void this.refresh(context);
    this.#feed = openFeed({
      onReset: async () => {
        if (!this.#streamIsCurrent(generation, contextKey)) return;
        this.#request?.abort();
        this.#request = undefined;
        this.#requestGeneration += 1;
        this.#state = Object.freeze({
          ...this.#state,
          sourceEpoch: this.#state.sourceEpoch + 1,
          dashboardBuildId: undefined,
          loading: false,
          status: undefined,
          error: undefined
        });
        this.#emit();
        await this.refresh(context);
      },
      onEvent: async (event) => {
        if (!this.#streamIsCurrent(generation, contextKey)) return;
        if (event.event === "snapshot" || event.event === "runtime") {
          await this.refresh(context);
        }
      },
      onError: (error) => {
        if (!this.#streamIsCurrent(generation, contextKey)) return;
        this.#state = Object.freeze({
          ...this.#state,
          error: error instanceof Error ? error.message : "Remote Access event stream failed."
        });
        this.#emit();
      }
    });
  }

  applySnapshot(context: ClientContext, status: RemoteAccessStatus): void {
    this.setContext(context);
    const buildChanged = this.#state.dashboardBuildId !== undefined
      && this.#state.dashboardBuildId !== status.dashboardBuildId;
    this.#state = Object.freeze({
      contextKey: this.#state.contextKey,
      sourceEpoch: this.#state.sourceEpoch + (buildChanged ? 1 : 0),
      dashboardBuildId: status.dashboardBuildId,
      loading: false,
      status,
      error: undefined
    });
    this.#emit();
  }

  async refresh(context: ClientContext): Promise<void> {
    this.setContext(context);
    this.#request?.abort();
    const request = new AbortController();
    const generation = ++this.#requestGeneration;
    const contextKey = this.#state.contextKey;
    this.#request = request;
    this.#state = Object.freeze({ ...this.#state, loading: true, error: undefined });
    this.#emit();
    try {
      const status = await this.#load(request.signal);
      if (
        request.signal.aborted
        || generation !== this.#requestGeneration
        || contextKey !== this.#state.contextKey
      ) return;
      this.applySnapshot(context, status);
    } catch (error) {
      if (
        request.signal.aborted
        || generation !== this.#requestGeneration
        || contextKey !== this.#state.contextKey
      ) return;
      this.#state = Object.freeze({
        ...this.#state,
        loading: false,
        error: error instanceof Error ? error.message : "Remote access status failed to load."
      });
      this.#emit();
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }

  stop(): void {
    this.#streamGeneration += 1;
    this.#feed?.close();
    this.#feed = undefined;
    this.#feedContextKey = undefined;
    this.#requestGeneration += 1;
    this.#request?.abort();
    this.#request = undefined;
    if (this.#state.loading) {
      this.#state = Object.freeze({ ...this.#state, loading: false });
      this.#emit();
    }
  }

  #streamIsCurrent(generation: number, contextKey: string): boolean {
    return generation === this.#streamGeneration && contextKey === this.#state.contextKey;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}
