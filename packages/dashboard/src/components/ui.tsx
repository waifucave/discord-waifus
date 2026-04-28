"use client";

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type PanelTone = "default" | "raised" | "elevated";

export function Panel({
  className,
  children,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: PanelTone }): JSX.Element {
  const tones: Record<PanelTone, string> = {
    default: "bg-surface border-border-soft shadow-card",
    raised: "bg-surface-raised border-border shadow-card",
    elevated: "bg-surface-elevated border-border shadow-elevated"
  };
  return (
    <div className={cn("rounded-2xl border", tones[tone], className)} {...props}>
      {children}
    </div>
  );
}

type ButtonTone = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg" | "icon";

export function Button({
  className,
  tone = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: ButtonSize }) {
  const tones: Record<ButtonTone, string> = {
    primary:
      "bg-accent text-white hover:bg-accent/90 active:bg-accent/85 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_4px_16px_rgba(139,92,246,0.30)]",
    secondary:
      "bg-white/[0.06] text-ink hover:bg-white/[0.10] border border-border-soft",
    ghost:
      "bg-transparent text-ink-muted hover:bg-white/[0.04] hover:text-ink",
    outline:
      "bg-transparent text-ink hover:bg-white/[0.04] border border-border",
    danger:
      "bg-danger/90 text-white hover:bg-danger active:bg-danger/95 border border-danger/40"
  };

  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
    md: "h-9 px-3.5 text-[13px] rounded-lg gap-2",
    lg: "h-10 px-4 text-sm rounded-xl gap-2",
    icon: "h-9 w-9 rounded-lg"
  };

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-medium transition duration-150 ease-smooth",
        "ring-focus disabled:cursor-not-allowed disabled:opacity-50",
        tones[tone],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}

const inputBase =
  "w-full rounded-lg border border-border-soft bg-white/[0.025] px-3 text-[13px] text-ink " +
  "placeholder:text-ink-subtle outline-none transition duration-150 ease-smooth " +
  "hover:border-border focus:border-accent/60 focus:bg-white/[0.04] " +
  "focus:shadow-[0_0_0_3px_rgba(139,92,246,0.18)] " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className={cn(inputBase, "h-9", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <textarea
      className={cn(inputBase, "min-h-[96px] py-2.5 leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      className={cn(
        inputBase,
        "h-9 appearance-none bg-[length:14px] bg-no-repeat pr-9",
        "bg-[image:url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%23a1a1aa%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22><polyline%20points=%226%209%2012%2015%2018%209%22/></svg>')]",
        "bg-[position:right_0.65rem_center]",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label
      className={cn(
        "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle",
        className
      )}
    >
      {children}
    </label>
  );
}

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function Badge({
  className,
  children,
  tone = "neutral"
}: {
  className?: string;
  children: ReactNode;
  tone?: BadgeTone;
}): JSX.Element {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-border bg-white/[0.04] text-ink-muted",
    ok: "border-ok/25 bg-ok/10 text-[rgb(110,231,183)]",
    warn: "border-warn/25 bg-warn/10 text-[rgb(252,211,77)]",
    danger: "border-danger/25 bg-danger/10 text-[rgb(253,164,175)]",
    accent: "border-accent/30 bg-accent/10 text-[rgb(196,181,253)]"
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  className
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-start md:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-subtle">
            {eyebrow}
          </p>
        ) : null}
        <h3 className={cn("font-display text-xl font-semibold tracking-tight text-ink", eyebrow && "mt-1.5")}>
          {title}
        </h3>
        {description ? (
          <div className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  className,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  className?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "ring-focus inline-flex items-center gap-2.5 transition disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    >
      <span
        className={cn(
          "relative h-5 w-9 rounded-full transition-colors duration-150",
          checked ? "bg-accent" : "bg-white/[0.10]"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 inline-block h-4 w-4 rounded-full bg-white shadow transition-all duration-150 ease-smooth",
            checked ? "left-[18px]" : "left-0.5"
          )}
        />
      </span>
      {label ? <span className="text-[13px] text-ink">{label}</span> : null}
    </button>
  );
}

export function Divider({ className }: { className?: string }): JSX.Element {
  return <div className={cn("h-px w-full bg-border-soft", className)} />;
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  cta,
  className
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  cta?: { href: string; label: string };
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-white/[0.015] px-6 py-10 text-center",
        className
      )}
    >
      {Icon ? (
        <div className="mb-3 rounded-full bg-white/[0.04] p-2.5">
          <Icon className="h-4 w-4 text-ink-subtle" />
        </div>
      ) : null}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-muted">{description}</p>
      ) : null}
      {cta ? (
        <Link
          href={cta.href}
          className="mt-4 inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent/90"
        >
          {cta.label}
        </Link>
      ) : null}
    </div>
  );
}

export function StatusDot({
  state,
  pulse = true,
  className
}: {
  state: "ok" | "warn" | "danger" | "idle";
  pulse?: boolean;
  className?: string;
}): JSX.Element {
  const colors: Record<typeof state, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    danger: "bg-danger",
    idle: "bg-ink-subtle"
  };
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)}>
      {pulse && state !== "idle" ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-50 dot-pulse",
            colors[state]
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", colors[state])} />
    </span>
  );
}

export function KeyValue({
  label,
  value,
  className
}: {
  label: string;
  value: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5", className)}>
      <span className="text-xs text-ink-subtle">{label}</span>
      <span className="text-[13px] font-medium text-ink">{value}</span>
    </div>
  );
}
