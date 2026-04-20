"use client";

import { LivePreview } from "@/components/live-preview";
import { PageFrame } from "@/components/page-frame";

export default function LivePage(): JSX.Element {
  return (
    <PageFrame>
      <LivePreview />
    </PageFrame>
  );
}
