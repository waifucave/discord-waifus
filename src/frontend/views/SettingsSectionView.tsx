import { SECTION_TABS } from "../nav";
import { Tabs } from "../components/Tabs";
import { ProvidersView } from "./ProvidersView";
import { SettingsView } from "./SettingsView";

export function SettingsSectionView({ tab, onTab }: { tab: string | undefined; onTab: (tab: string) => void }) {
  return (
    <>
      <Tabs tabs={SECTION_TABS["app-settings"] ?? []} active={tab} onSelect={onTab} />
      {tab === "app" ? <SettingsView /> : <ProvidersView />}
    </>
  );
}
