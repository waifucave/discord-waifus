import type { RemoteAccessRuntimeSummary } from "../runtime.js";

export type RemoteAccessStatusListener = (summary: RemoteAccessRuntimeSummary) => void;

export class RemoteAccessEvents {
  readonly #listeners = new Set<RemoteAccessStatusListener>();

  subscribe(listener: RemoteAccessStatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(summary: RemoteAccessRuntimeSummary): void {
    for (const listener of this.#listeners) listener(summary);
  }

  clear(): void {
    this.#listeners.clear();
  }
}
