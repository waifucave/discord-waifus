import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * A confirmation dialog (Reset, Forget): `role="dialog"`, Escape or a click on the backdrop
 * cancels, focus starts on the safe choice, Tab stays inside, and focus returns to the opener.
 */
export function ConfirmDialog({
  title,
  children,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  busy = false,
  width = 520,
  returnFocus
}: {
  title: string;
  children: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  width?: number;
  /** Where focus goes back to (the button that opened it, which may have been disabled meanwhile). */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const back = useRef(returnFocus);
  back.current = returnFocus;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const target = back.current?.() ?? (opener && opener !== document.body ? opener : undefined);
      // After the dialog is gone (a button disabled while it ran is enabled again by then).
      if (target) window.setTimeout(() => target.focus(), 0);
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} style={{ width }}>
        <div className="modal-header">
          <span className="t-title" id={titleId}>
            {title}
          </span>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">
          <button ref={cancelRef} className="cell clickable" style={{ background: "var(--paper)" }} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="cell clickable" style={{ background: "var(--danger)" }} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
