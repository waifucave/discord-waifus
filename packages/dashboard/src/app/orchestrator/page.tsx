"use client";

import { OrchestratorManager } from "@/components/orchestrator-manager";
import { PageFrame } from "@/components/page-frame";

export default function OrchestratorPage(): JSX.Element {
  return (
    <PageFrame>
      <OrchestratorManager />
    </PageFrame>
  );
}
