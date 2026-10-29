// `apply_patch` (Living cast spec §32.2): Codex's patch grammar and matching, exactly, as a pure
// parser and file updater (openai/codex `codex-rs/apply-patch`: the streaming parser, `seek_sequence`
// and `compute_replacements`):
//
//   *** Begin Patch
//   *** Add File: <path>          then `+` lines (the new file)
//   *** Delete File: <path>
//   *** Update File: <path>       optionally `*** Move to: <path>`, then chunks: `@@` or `@@ <anchor
//                                  line>`, lines prefixed ' ' (context), '-' (removed), '+' (added),
//                                  optionally `*** End of File` (the chunk is at the file's end)
//   *** End Patch
//
// Matching, per chunk in file order against the file as it was: the anchor (one line) is looked for
// from where the previous chunk ended and narrows the search to after it; the chunk's old lines
// (context and removed) are then looked for exact, else ignoring trailing whitespace, else ignoring
// both ends' whitespace, else with Unicode dashes, quotes and spaces made ASCII; a chunk marked End of
// File is looked for only at the end; a chunk with no old lines appends at the end of the file. Lines
// keep their own endings; inserted ones get the file's first ending, and every line ends with one.
//
// Safer than Codex (owner choice, §32.3a): a chunk whose old lines match in two places (in the first
// pass that finds them, after the anchor and End of File constraints) is refused with both line
// numbers, and so is an `@@` anchor line found twice; overlapping chunks are refused. The rest (all
// files or none, one Update per file, Add File and Move onto an existing file, her folder rules) is
// the tool's, in files.ts.

export const BEGIN_PATCH = "*** Begin Patch";
export const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";

export type PatchChunk = {
  /** The anchor line (`@@ <line>`), narrowing where the chunk is. */
  context?: string;
  oldLines: string[];
  newLines: string[];
  /** Pairs of indices into oldLines/newLines that are context lines (kept as in the file). */
  contextIndices: Array<[number, number]>;
  endOfFile: boolean;
};

export type PatchHunk =
  | { kind: "add"; path: string; contents: string; line: number }
  | { kind: "delete"; path: string; line: number }
  | { kind: "update"; path: string; movePath?: string; chunks: PatchChunk[]; line: number };

export type ParsedPatch = { ok: true; hunks: PatchHunk[] } | { ok: false; error: string };

const HEADERS = "'*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

/** Codex's parse (lenient boundaries: a heredoc `<<EOF … EOF` around it is taken off). */
export function parsePatch(patch: string): ParsedPatch {
  const all = patch.trim().split(/\r?\n/u);
  let lines = all;
  const boundaries = (list: string[]): string | undefined => {
    const first = list[0]?.trim();
    const last = list[list.length - 1]?.trim();
    if (first !== BEGIN_PATCH) return "The first line of the patch must be '*** Begin Patch'";
    if (last !== END_PATCH) return "The last line of the patch must be '*** End Patch'";
    return undefined;
  };
  let problem = boundaries(lines);
  if (problem && lines.length >= 4 && ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]!) && lines[lines.length - 1]!.endsWith("EOF")) {
    const inner = lines.slice(1, -1);
    if (!boundaries(inner)) {
      lines = inner;
      problem = undefined;
    }
  }
  if (problem) return { ok: false, error: `invalid patch: ${problem}` };

  type Mode = { kind: "notStarted" } | { kind: "started" } | { kind: "add" } | { kind: "delete" } | { kind: "update"; hunkLine: number } | { kind: "ended" };
  let mode: Mode = { kind: "notStarted" };
  const hunks: PatchHunk[] = [];
  let lineNumber = 0;
  const hunkError = (message: string, line = lineNumber): ParsedPatch => ({ ok: false, error: `invalid hunk at line ${line}, ${message}` });
  const emptyChunk = (): PatchChunk => ({ oldLines: [], newLines: [], contextIndices: [], endOfFile: false });

  /** An update hunk must have something in it before the next header (Codex's check). */
  const updateNotEmpty = (line: string): ParsedPatch | undefined => {
    const last = hunks[hunks.length - 1];
    if (last?.kind !== "update") return undefined;
    if (last.chunks.length === 0 && mode.kind === "update") return hunkError(`Update file hunk for path '${last.path}' is empty`, mode.hunkLine);
    const chunk = last.chunks[last.chunks.length - 1];
    if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      if (line === END_PATCH) return hunkError("Update hunk does not contain any lines");
      return hunkError(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
    }
    return undefined;
  };

  /** A header or the end: true when `trimmed` was one. */
  const header = (trimmed: string): ParsedPatch | true | false => {
    if (trimmed === END_PATCH) {
      const bad = updateNotEmpty(trimmed);
      if (bad) return bad;
      mode = { kind: "ended" };
      return true;
    }
    for (const [marker, kind] of [[ADD_FILE, "add"], [DELETE_FILE, "delete"], [UPDATE_FILE, "update"]] as const) {
      if (!trimmed.startsWith(marker)) continue;
      const bad = updateNotEmpty(trimmed);
      if (bad) return bad;
      const path = trimmed.slice(marker.length);
      if (kind === "add") {
        hunks.push({ kind: "add", path, contents: "", line: lineNumber });
        mode = { kind: "add" };
      } else if (kind === "delete") {
        hunks.push({ kind: "delete", path, line: lineNumber });
        mode = { kind: "delete" };
      } else {
        hunks.push({ kind: "update", path, chunks: [], line: lineNumber });
        mode = { kind: "update", hunkLine: lineNumber };
      }
      return true;
    }
    return false;
  };

  const process = (line: string): ParsedPatch | undefined => {
    const trimmed = line.trim();
    switch (mode.kind) {
      case "notStarted":
        if (trimmed === BEGIN_PATCH) {
          mode = { kind: "started" };
          return undefined;
        }
        return { ok: false, error: "invalid patch: The first line of the patch must be '*** Begin Patch'" };
      case "started":
      case "delete": {
        const h = header(trimmed);
        if (h === true) return undefined;
        if (h !== false) return h;
        return hunkError(`'${trimmed}' is not a valid hunk header. Valid hunk headers: ${HEADERS}`);
      }
      case "add": {
        const h = header(trimmed);
        if (h === true) return undefined;
        if (h !== false) return h;
        const last = hunks[hunks.length - 1];
        if (line.startsWith("+") && last?.kind === "add") {
          last.contents += `${line.slice(1)}\n`;
          return undefined;
        }
        return hunkError(`'${trimmed}' is not a valid hunk header. Valid hunk headers: ${HEADERS}`);
      }
      case "update": {
        const updateLine = line.replace(/\s+$/u, "");
        const h = header(updateLine);
        if (h === true) return undefined;
        if (h !== false) return h;
        const hunk = hunks[hunks.length - 1];
        if (hunk?.kind !== "update") break;
        const chunks = hunk.chunks;
        const last = chunks[chunks.length - 1];
        if (last?.endOfFile) {
          if (updateLine === "") return undefined;
          if (updateLine !== EMPTY_CHANGE_CONTEXT && !updateLine.startsWith(CHANGE_CONTEXT)) return hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
        }
        if (chunks.length === 0 && hunk.movePath === undefined && updateLine.startsWith(MOVE_TO)) {
          hunk.movePath = updateLine.slice(MOVE_TO.length);
          return undefined;
        }
        const bare = (chunk: PatchChunk | undefined) => chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;
        if ((updateLine === EMPTY_CHANGE_CONTEXT || updateLine.startsWith(CHANGE_CONTEXT)) && bare(last)) {
          return hunkError(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
        }
        if (updateLine === EMPTY_CHANGE_CONTEXT) {
          chunks.push(emptyChunk());
          return undefined;
        }
        if (updateLine.startsWith(CHANGE_CONTEXT)) {
          chunks.push({ ...emptyChunk(), context: updateLine.slice(CHANGE_CONTEXT.length) });
          return undefined;
        }
        if (updateLine === END_OF_FILE) {
          if (bare(last)) return hunkError("Update hunk does not contain any lines");
          if (last) last.endOfFile = true;
          return undefined;
        }
        const current = () => {
          if (chunks.length === 0) chunks.push(emptyChunk());
          return chunks[chunks.length - 1]!;
        };
        if (line === "") {
          const chunk = current();
          chunk.contextIndices.push([chunk.oldLines.length, chunk.newLines.length]);
          chunk.oldLines.push("");
          chunk.newLines.push("");
          return undefined;
        }
        if (line.startsWith(" ")) {
          const chunk = current();
          chunk.contextIndices.push([chunk.oldLines.length, chunk.newLines.length]);
          chunk.oldLines.push(line.slice(1));
          chunk.newLines.push(line.slice(1));
          return undefined;
        }
        if (line.startsWith("+")) {
          current().newLines.push(line.slice(1));
          return undefined;
        }
        if (line.startsWith("-")) {
          current().oldLines.push(line.slice(1));
          return undefined;
        }
        if (last && (last.oldLines.length > 0 || last.newLines.length > 0)) return hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
        break;
      }
      case "ended":
        if (trimmed === "") return undefined;
        return { ok: false, error: "invalid patch: The last line of the patch must be '*** End Patch'" };
    }
    return hunkError(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
  };

  for (const line of lines) {
    lineNumber += 1;
    const bad = process(line);
    if (bad) return bad;
  }
  if ((mode as Mode).kind !== "ended") return { ok: false, error: "invalid patch: The last line of the patch must be '*** End Patch'" };
  return { ok: true, hunks };
}

// ---- matching (seek_sequence) -------------------------------------------------------------------------

const DASHES = /[‐-―−]/gu;
const SINGLE_QUOTES = /[‘-‛]/gu;
const DOUBLE_QUOTES = /[“-‟]/gu;
const SPACES = /[  -   　]/gu;

/** Codex's last pass: trimmed, Unicode dashes, quotes and odd spaces made ASCII. */
export function normalisePunctuation(text: string): string {
  return text.trim().replace(DASHES, "-").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(SPACES, " ");
}

// JavaScript's trim() also takes U+FEFF and a few more than Rust's (Unicode White_Space): close enough
// for lines of text.
const PASSES: Array<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalisePunctuation(a) === normalisePunctuation(b)
];

export type Seek = { found: number } | { none: true } | { ambiguous: [number, number] };

/**
 * Where `pattern` is in `lines`, at or after `start` (0-based), by the first pass that finds it; an
 * End of File chunk only at the end. Two places in that pass: ambiguous (both, 0-based).
 */
export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean, o: { unique?: boolean } = {}): Seek {
  if (pattern.length === 0) return { found: start };
  if (pattern.length > lines.length) return { none: true };
  const searchStart = eof ? Math.max(lines.length - pattern.length, start) : start;
  for (const same of PASSES) {
    const hits: number[] = [];
    for (let i = searchStart; i <= lines.length - pattern.length; i += 1) {
      let ok = true;
      for (let p = 0; p < pattern.length; p += 1) {
        if (!same(lines[i + p]!, pattern[p]!)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      hits.push(i);
      if (!o.unique || hits.length > 1) break;
    }
    if (hits.length > 1) return { ambiguous: [hits[0]!, hits[1]!] };
    if (hits.length === 1) return { found: hits[0]! };
  }
  return { none: true };
}

// ---- the file (text_file.rs) ---------------------------------------------------------------------------

type SourceLine = { text: string; ending: string | undefined };

function parseSource(contents: string): { lines: SourceLine[]; preferred: string } {
  const lines: SourceLine[] = [];
  let preferred: string | undefined;
  let lineStart = 0;
  let cursor = 0;
  while (cursor < contents.length) {
    const char = contents[cursor];
    let ending: string | undefined;
    if (char === "\r") ending = contents[cursor + 1] === "\n" ? "\r\n" : "\r";
    else if (char === "\n") ending = "\n";
    if (ending === undefined) {
      cursor += 1;
      continue;
    }
    preferred ??= ending;
    lines.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += ending.length;
    lineStart = cursor;
  }
  if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: undefined });
  return { lines, preferred: preferred ?? "\n" };
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

export type UpdateResult = { ok: true; contents: string } | { ok: false; error: string };

/**
 * The file after one Update hunk's chunks (Codex's compute_replacements and apply_replacements), or
 * why a chunk can't be placed: not found, or (ours) found in two places. `path` names the file in errors.
 */
export function updateContents(original: string, chunks: readonly PatchChunk[], path: string): UpdateResult {
  const source = parseSource(original);
  const lines = source.lines.map((line) => line.text);
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      // Ours: an anchor line found twice (in the pass that found it) is refused like a chunk (§32.3a).
      const anchor = seekSequence(lines, [chunk.context], lineIndex, false, { unique: true });
      if ("ambiguous" in anchor) {
        const [a, b] = anchor.ambiguous;
        return { ok: false, error: `the @@ line '${chunk.context}' is in ${path} twice (lines ${a + 1} and ${b + 1}); use a line that is there once` };
      }
      if (!("found" in anchor)) return { ok: false, error: `Failed to find context '${chunk.context}' in ${path}` };
      lineIndex = anchor.found + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile, { unique: true });
    if ("none" in found && pattern[pattern.length - 1] === "") {
      // The final empty line stands for the file's last newline (SourceFile keeps it on the line before).
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile, { unique: true });
    }
    if ("ambiguous" in found) {
      const [a, b] = found.ambiguous;
      return { ok: false, error: `the lines to change in ${path} match in 2 places (lines ${a + 1} and ${b + 1}); add a line above or below to say which` };
    }
    if ("none" in found) return { ok: false, error: `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}` };
    const startIndex = found.found;
    // Context lines stay as they are in the file (their exact text and endings).
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break;
      if (oldStart !== oldContext || newStart !== newContext) replacements.push([startIndex + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)]);
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) replacements.push([startIndex + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
    lineIndex = startIndex + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  const out: SourceLine[] = [];
  let sourceIndex = 0;
  for (const [start, oldLength, newLines] of replacements) {
    // Overlapping chunks can't happen: each is found after the one before (Codex's assertion).
    if (start < sourceIndex) return { ok: false, error: `the changes to ${path} overlap; put the chunks in file order` };
    out.push(...source.lines.slice(sourceIndex, start));
    out.push(...newLines.map((text) => ({ text, ending: source.preferred })));
    sourceIndex = start + oldLength;
  }
  out.push(...source.lines.slice(sourceIndex));
  // Updates have always added a trailing newline.
  return { ok: true, contents: out.map((line) => `${line.text}${line.ending ?? source.preferred}`).join("") };
}
