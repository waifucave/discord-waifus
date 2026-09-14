import type { CSSProperties, ReactNode } from "react";
import type { ClientContext } from "../api/types";
import { useClientContext } from "../state/clientContext";

export type ContextExternalLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function ContextExternalLinkView({
  context,
  href,
  children,
  className,
  style
}: ContextExternalLinkProps & { context: ClientContext }) {
  if (context.mode === "host") {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer" style={style}>
        {children}
      </a>
    );
  }
  return (
    <span className={[className, "external-link-copy"].filter(Boolean).join(" ")} style={style}>
      <span>{children}</span>
      <span className="t-micro t-mute">Copy this URL:</span>
      <code className="mono">{href}</code>
    </span>
  );
}

export function ContextExternalLink(props: ContextExternalLinkProps) {
  return <ContextExternalLinkView {...props} context={useClientContext()} />;
}
