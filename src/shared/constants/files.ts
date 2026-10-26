// Her files over HTTP (Living cast spec §16.11), shared by the CLI, the dashboard and the assistant
// (zod-free, so the dashboard may import it).

/** What a file or folder from a private chat is called unless a local request says `includePrivate=1` (D14). */
export const PRIVATE_FILE_NAME = "[private chat redacted]";

/**
 * A path as the owner (or the assistant) wrote it → her path (`/…` or `~…`). A relative path means
 * her home, or `/tmp` (`/transcripts`) when `root` is `tmp` (`transcripts`); nothing at all means the root itself.
 */
export function herPathInput(raw: string | undefined, root: "home" | "tmp" | "transcripts" = "home"): string {
  const text = (raw ?? "").trim();
  if (!text) return root === "home" ? "~" : `/${root}`;
  if (text.startsWith("/") || text === "~" || text.startsWith("~/")) return text;
  return root === "home" ? `~/${text}` : `/${root}/${text}`;
}

/**
 * The URL of one of her files: her path without the leading slash, each segment encoded
 * (`/api/waifus/aria/files/home/aria/people/kevin.md`, `/api/waifus/aria/files/~/plans.md`).
 */
export function herFileUrl(waifuId: string, herPath: string): string {
  const rest = herPath.startsWith("/") ? herPath.slice(1) : herPath;
  const segments = rest.split("/").filter((segment, index) => segment !== "" || index === 0);
  return `/api/waifus/${encodeURIComponent(waifuId)}/files/${segments.map((segment) => (segment === "~" ? "~" : encodeURIComponent(segment))).join("/")}`;
}
