export function Skeleton({ height = 14, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function SkeletonRows({ rows = 3, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={height} width={`${60 + ((i * 7) % 40)}%`} />
      ))}
    </div>
  );
}
