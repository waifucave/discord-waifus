"use client";

import { DashboardHome } from "@/components/dashboard-home";
import { PageFrame } from "@/components/page-frame";

export default function HomePage(): JSX.Element {
  return (
    <PageFrame>
      <DashboardHome />
    </PageFrame>
  );
}
