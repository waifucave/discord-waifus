"use client";

import { PageFrame } from "@/components/page-frame";
import { WaifuManager } from "@/components/waifu-manager";

export default function WaifusPage(): JSX.Element {
  return (
    <PageFrame>
      <WaifuManager />
    </PageFrame>
  );
}
