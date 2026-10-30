/** Section registry for navigation. Hue names map to system.css vars. */
export type ViewId = "home" | "cast" | "life" | "rooms" | "activity" | "settings";

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
  { id: "life", index: "03", label: "Life", hue: "lavender" },
  { id: "rooms", index: "04", label: "Rooms", hue: "sky" },
  { id: "activity", index: "05", label: "Activity", hue: "peach" },
  { id: "settings", index: "06", label: "Settings", hue: "mint", inverts: true }
];

/** Tab sets per section; first entry is the default. */
export const SECTION_TABS: Partial<Record<ViewId, Array<{ id: string; label: string }>>> = {
  activity: [
    { id: "logs", label: "Logs" },
    { id: "queries", label: "Model calls" },
    { id: "replies", label: "Model replies" },
    { id: "usage", label: "Usage" }
  ],
  settings: [
    { id: "providers", label: "Providers" },
    { id: "models", label: "Models" },
    { id: "search", label: "Search" },
    { id: "detector", label: "Detector" },
    { id: "life", label: "Life limits" },
    { id: "assistant", label: "Assistant" },
    { id: "permissions", label: "Permissions" },
    { id: "app", label: "App" },
    { id: "remote-access", label: "Remote Access" }
  ]
};

/** Character hue assignment: stable, cyclic, by cast order. */
export const CHARACTER_HUES = ["mint", "pink", "butter", "sky", "peach", "lavender"] as const;
export function characterHue(index: number): (typeof CHARACTER_HUES)[number] {
  return CHARACTER_HUES[index % CHARACTER_HUES.length];
}
