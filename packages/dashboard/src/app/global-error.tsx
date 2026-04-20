"use client";

export default function GlobalError({
  error
}: {
  error: Error & { digest?: string };
}): JSX.Element {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <div className="max-w-lg text-center">
          <p className="text-xs uppercase tracking-[0.4em] text-slate-500">Fatal Error</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">The dashboard could not render.</h1>
          <p className="mt-4 text-sm text-slate-400">{error.message}</p>
        </div>
      </body>
    </html>
  );
}
