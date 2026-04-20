"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "./app-shell";

export function PageFrame({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname();
  return <AppShell pathname={pathname}>{children}</AppShell>;
}
