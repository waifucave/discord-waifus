"use client";

import { PageFrame } from "@/components/page-frame";
import { StageManagerManager } from "@/components/stage-manager-manager";

export default function StageManagerPage(): JSX.Element {
  return (
    <PageFrame>
      <StageManagerManager />
    </PageFrame>
  );
}
