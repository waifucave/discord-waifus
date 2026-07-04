export function Tabs({
  tabs,
  active,
  onSelect
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          className={"tab" + (tab.id === active ? " active" : "")}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
