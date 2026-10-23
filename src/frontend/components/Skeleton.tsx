export function Skeleton({ height = 14, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}
