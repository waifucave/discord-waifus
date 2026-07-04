import { SECTION_TABS } from "../nav";
import { Tabs } from "../components/Tabs";
import { LogsView } from "./LogsView";
import { QueriesView } from "./QueriesView";
import { RepliesView } from "./RepliesView";

export function ActivityView({ tab, onTab }: { tab: string | undefined; onTab: (tab: string) => void }) {
  return (
    <>
      <Tabs tabs={SECTION_TABS.activity ?? []} active={tab} onSelect={onTab} />
      {tab === "queries" ? <QueriesView /> : tab === "replies" ? <RepliesView /> : <LogsView />}
    </>
  );
}
