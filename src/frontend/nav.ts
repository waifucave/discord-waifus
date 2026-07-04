/** Section registry for the home-launcher navigation. Hue names map to system.css vars. */
export type ViewId = "home" | "cast" | "rooms" | "direction" | "memory" | "activity" | "settings";

export type SectionDef = {
  id: Exclude<ViewId, "home">;
  index: string;
  label: string;
  hue: "mint" | "sky" | "lavender" | "butter" | "peach" | "pink";
  /** Settings inverts to ink on hover instead of a hue. */
  inverts?: boolean;
};

export const SECTIONS: SectionDef[] = [
  { id: "cast", index: "02", label: "Cast", hue: "mint" },
  { id: "rooms", index: "03", label: "Rooms", hue: "sky" },
  { id: "direction", index: "04", label: "Direction", hue: "lavender" },
  { id: "memory", index: "05", label: "Memory", hue: "butter" },
  { id: "activity", index: "06", label: "Activity", hue: "peach" },
  { id: "settings", index: "07", label: "Settings", hue: "mint", inverts: true }
];

/** Tab sets per section; first entry is the default. */
export const SECTION_TABS: Partial<Record<ViewId, Array<{ id: string; label: string }>>> = {
  direction: [
    { id: "orchestrator", label: "Orchestrator" },
    { id: "stage-manager", label: "Stage manager" },
    { id: "reviewer", label: "Reviewer" },
    { id: "assistant", label: "Assistant" }
  ],
  activity: [
    { id: "logs", label: "Logs" },
    { id: "queries", label: "Queries" },
    { id: "replies", label: "Replies" }
  ],
  settings: [
    { id: "providers", label: "Providers" },
    { id: "app", label: "App" }
  ]
};

/** Character hue assignment: stable, cyclic, by cast order. */
export const CHARACTER_HUES = ["mint", "pink", "butter", "sky", "peach", "lavender"] as const;
export function characterHue(index: number): (typeof CHARACTER_HUES)[number] {
  return CHARACTER_HUES[index % CHARACTER_HUES.length];
}
