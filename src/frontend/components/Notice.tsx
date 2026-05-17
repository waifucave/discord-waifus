import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

export type NoticeTone = "ok" | "warn" | "err" | "info";

const ICONS: Record<NoticeTone, typeof Info> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  err: AlertCircle,
  info: Info
};

export function Notice({
  tone = "info",
  title,
  children
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div className={"notice " + tone}>
      <Icon className="icon" />
      <div>
        {title && <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}
