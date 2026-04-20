"use client";

import { InstructionsPage } from "@/components/instructions-page";
import { PageFrame } from "@/components/page-frame";

export default function InstructionsRoute(): JSX.Element {
  return (
    <PageFrame>
      <InstructionsPage />
    </PageFrame>
  );
}
