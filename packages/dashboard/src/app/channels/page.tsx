"use client";

import { ChannelsManager } from "@/components/channels-manager";
import { PageFrame } from "@/components/page-frame";

export default function ChannelsPage(): JSX.Element {
  return (
    <PageFrame>
      <ChannelsManager />
    </PageFrame>
  );
}
