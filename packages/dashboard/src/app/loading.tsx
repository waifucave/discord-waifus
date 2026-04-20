export default function Loading(): JSX.Element {
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6">
      <div className="animate-pulse space-y-6">
        <div className="h-28 rounded-[32px] bg-white/5" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="h-40 rounded-[32px] bg-white/5" />
          <div className="h-40 rounded-[32px] bg-white/5" />
          <div className="h-40 rounded-[32px] bg-white/5" />
        </div>
      </div>
    </div>
  );
}
