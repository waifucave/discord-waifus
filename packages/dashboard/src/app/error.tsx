"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Dashboard Error</p>
      <h2 className="mt-4 font-display text-4xl font-semibold">Something broke in the control room.</h2>
      <p className="mt-4 text-sm text-slate-400">{error.message}</p>
      <button
        className="mt-8 rounded-2xl bg-accent px-5 py-3 text-sm font-medium text-slate-950"
        onClick={() => reset()}
      >
        Retry
      </button>
    </div>
  );
}
