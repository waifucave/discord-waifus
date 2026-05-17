import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export function Empty({
  icon,
  title,
  children,
  action
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ?? <Inbox className="icon-lg" />}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-help">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
