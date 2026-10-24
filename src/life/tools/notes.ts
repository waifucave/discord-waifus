// Notes tools (Living cast spec §6.7): list, read, write, edit, delete and search her notes.

import { z } from "zod";
import { MAX_NOTE_FILES, MAX_NOTES_TOTAL_BYTES, Notes, NotesError, validateNotePath } from "../notes.js";
import { parseInput, toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

function notesOf(ctx: ToolContext): Notes {
  return new Notes(ctx.deps.storage, ctx.waifu.id);
}

function failure(error: unknown): ToolOutput {
  if (error instanceof NotesError) return toolError(error.message);
  throw error;
}

const PathInput = z.object({ path: z.string() });

function checkedPath(path: string): { ok: true; path: string } | { ok: false; output: ToolOutput } {
  const checked = validateNotePath(path);
  return checked.ok ? checked : { ok: false, output: toolError(checked.error) };
}

async function listNotes(_input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const notes = await notesOf(ctx).list();
  if (notes.length === 0) return { content: "(no notes yet; MEMORY.md is your index)" };
  const total = notes.reduce((sum, note) => sum + note.bytes, 0);
  const lines = notes.map((note) => `${note.path} (${Math.max(1, Math.round(note.bytes / 102.4) / 10)} KB)`);
  lines.push(`${notes.length}/${MAX_NOTE_FILES} notes, ${Math.round(total / 1024)} KB of ${MAX_NOTES_TOTAL_BYTES / 1024} KB`);
  return { content: lines.join("\n") };
}

async function readNote(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(PathInput, input);
  if (!parsed.ok) return parsed.output;
  const path = checkedPath(parsed.value.path);
  if (!path.ok) return path.output;
  const text = await notesOf(ctx).read(path.path);
  if (text === undefined) return toolError(`no note at ${path.path}`);
  return { content: text.length > 0 ? text : "(empty note)" };
}

const WriteInput = z.object({ path: z.string(), content: z.string() });

async function writeNote(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(WriteInput, input);
  if (!parsed.ok) return parsed.output;
  const path = checkedPath(parsed.value.path);
  if (!path.ok) return path.output;
  try {
    const result = await notesOf(ctx).write(path.path, parsed.value.content);
    return { content: `${result} ${path.path}` };
  } catch (error) {
    return failure(error);
  }
}

const EditInput = z.object({ path: z.string(), find: z.string().min(1), replace: z.string() });

async function editNote(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(EditInput, input);
  if (!parsed.ok) return parsed.output;
  const path = checkedPath(parsed.value.path);
  if (!path.ok) return path.output;
  try {
    await notesOf(ctx).edit(path.path, parsed.value.find, parsed.value.replace);
    return { content: `edited ${path.path}` };
  } catch (error) {
    return failure(error);
  }
}

async function deleteNote(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(PathInput, input);
  if (!parsed.ok) return parsed.output;
  const path = checkedPath(parsed.value.path);
  if (!path.ok) return path.output;
  const existed = await notesOf(ctx).delete(path.path);
  return existed ? { content: `deleted ${path.path}` } : toolError(`no note at ${path.path}`);
}

const SearchInput = z.object({ query: z.string().min(1).max(200) });

async function searchNotes(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(SearchInput, input);
  if (!parsed.ok) return parsed.output;
  const hits = await notesOf(ctx).search(parsed.value.query);
  if (hits.length === 0) return { content: "(nothing found)" };
  return { content: hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n") };
}

const pathSchema = { type: "string", description: "MEMORY.md, or a path like people/kevin.md (1–3 lower-case segments ending in .md)." };

export const NOTE_TOOL_NAMES = ["list_notes", "read_note", "write_note", "edit_note", "delete_note", "search_notes"] as const;

export const noteTools: LifeTool[] = [
  {
    name: "list_notes",
    description: "List your notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    sideEffect: false,
    run: listNotes
  },
  {
    name: "read_note",
    description: "Read one of your notes.",
    inputSchema: { type: "object", properties: { path: pathSchema }, required: ["path"], additionalProperties: false },
    sideEffect: false,
    run: readNote
  },
  {
    name: "write_note",
    description: "Write a note (creates it or replaces it whole). Keep MEMORY.md as a short index with one line per note and links to the details.",
    inputSchema: {
      type: "object",
      properties: { path: pathSchema, content: { type: "string", description: "The whole note, in Markdown (at most 16 KB)." } },
      required: ["path", "content"],
      additionalProperties: false
    },
    sideEffect: true,
    run: writeNote
  },
  {
    name: "edit_note",
    description: "Replace exactly one occurrence of some text in a note.",
    inputSchema: {
      type: "object",
      properties: { path: pathSchema, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
      additionalProperties: false
    },
    sideEffect: true,
    run: editNote
  },
  {
    name: "delete_note",
    description: "Delete a note.",
    inputSchema: { type: "object", properties: { path: pathSchema }, required: ["path"], additionalProperties: false },
    sideEffect: true,
    run: deleteNote
  },
  {
    name: "search_notes",
    description: "Find lines in your notes that contain every word of the query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    sideEffect: false,
    run: searchNotes
  }
];
