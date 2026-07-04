import { FootRow, HeadRow } from "./scaffold";

/** Temporary placeholder while a section is being rebuilt. Removed by the end of the plan. */
export function ComingScreen({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="screen">
      <HeadRow onBack={onBack} title={title} />
      <div className="content">
        <div className="cell growcell" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="t-mute">This screen is being rebuilt.</span>
        </div>
      </div>
      <FootRow />
    </div>
  );
}
