import type { ReactNode } from "react";

/**
 * A section heading row in the fused column: an optional mono index, a plain title, one quiet line
 * of help, and the section's own buttons at the end. Used by the Cast editor and every Settings tab.
 */
export function SectionHead({
  index,
  title,
  hint,
  actions,
  tone,
  id
}: {
  index?: string;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  tone?: "danger";
  id?: string;
}) {
  return (
    <div className={"cell section-head" + (tone ? ` ${tone}` : "")}>
      <div className="section-text">
        <div className="section-name">
          {index && <span className="t-micro">{index}</span>}
          <h2 className="t-title" id={id} style={{ fontWeight: 400 }}>
            {title}
          </h2>
        </div>
        {hint && <div className="section-hint">{hint}</div>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}
