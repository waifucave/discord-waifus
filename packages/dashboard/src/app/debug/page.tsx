"use client";

import { DebugPanel } from "@/components/debug-panel";
import { PageFrame } from "@/components/page-frame";

export default function DebugPage(): JSX.Element {
  return (
    <PageFrame>
      <DebugPanel />
    </PageFrame>
  );
}
