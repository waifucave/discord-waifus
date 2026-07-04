import { SECTION_TABS } from "../nav";
import { Tabs } from "../components/Tabs";
import { OrchestratorView } from "./OrchestratorView";
import { StageManagerView } from "./StageManagerView";
import { ReviewerView } from "./ReviewerView";
import { AssistantView } from "./AssistantView";

export function DirectionView({ tab, onTab }: { tab: string | undefined; onTab: (tab: string) => void }) {
  return (
    <>
      <Tabs tabs={SECTION_TABS.direction ?? []} active={tab} onSelect={onTab} />
      {tab === "stage-manager" ? (
        <StageManagerView />
      ) : tab === "reviewer" ? (
        <ReviewerView />
      ) : tab === "assistant" ? (
        <AssistantView />
      ) : (
        <OrchestratorView />
      )}
    </>
  );
}
