import type { ReactNode } from "react";

export type PillTone = "ok" | "warn" | "err" | "info" | "neutral";

export function Pill({
  tone = "neutral",
  dot = false,
  children
}: {
  tone?: PillTone;
  dot?: boolean;
  children: ReactNode;
}) {
  const cls = ["pill", tone === "neutral" ? "" : tone, dot ? "dot" : ""].filter(Boolean).join(" ");
  return <span className={cls}>{children}</span>;
}
