"use client";

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from "react";
import { cn } from "@/lib/utils";

export function Panel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn("glass rounded-3xl border border-border/60 shadow-aura", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function Button({
  className,
  tone = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }) {
  const tones = {
    primary: "bg-accent text-slate-950 hover:bg-sky-300",
    ghost: "bg-white/5 text-ink hover:bg-white/10",
    danger: "bg-rose-500/85 text-white hover:bg-rose-400"
  };

  return (
    <button
      className={cn(
        "inline-flex h-11 items-center justify-center rounded-2xl px-4 text-sm font-medium transition",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      className="h-11 w-full rounded-2xl border border-border/70 bg-black/20 px-4 text-sm text-ink outline-none transition focus:border-accent/80"
      {...props}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <textarea
      className="min-h-[110px] w-full rounded-2xl border border-border/70 bg-black/20 px-4 py-3 text-sm text-ink outline-none transition focus:border-accent/80"
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
        "h-11 w-full rounded-2xl border border-border/70 bg-black/20 px-4 text-sm text-ink outline-none transition focus:border-accent/80",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }): JSX.Element {
  return (
    <label className="mb-2 block text-xs uppercase tracking-[0.28em] text-slate-400">
      {children}
    </label>
  );
}

export function Badge({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200",
        className
      )}
    >
      {children}
    </span>
  );
}
