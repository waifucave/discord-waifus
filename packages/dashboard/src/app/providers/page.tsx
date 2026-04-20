"use client";

import { PageFrame } from "@/components/page-frame";
import { ProvidersManager } from "@/components/providers-manager";

export default function ProvidersPage(): JSX.Element {
  return (
    <PageFrame>
      <ProvidersManager />
    </PageFrame>
  );
}
