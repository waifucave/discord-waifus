// Her own computer on the Life screen (Living cast spec §16.11, §18.3): a browser for her home, /tmp
// and her read-only /transcripts (a private chat's transcript only with the reveal), a
// text editor that saves under her Write tool's checks (the server's message is shown as it is, a
// JSON line and column included), image previews, and her reminders and watches with delete
// buttons. Files from private chats arrive unnamed unless the reveal is on (local only, D14); the
// screen keys these panels by the reveal, so nothing revealed survives turning it off.

import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { HerFile, HerFileEntry, HerFilesList, ScheduleResponse, WatchesResponse } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Notice } from "../components/Notice";
import { breadcrumbs, entryDetail, fileSize, matchingReveal, PRIVATE_HIDDEN, watchWhenText, when } from "./lifeView";

type Message = { tone: "ok" | "err" | "warn"; text: string };

/** The file browser: her home or /tmp, one folder at a time, and the file open below it. */
export function HerFilesPanel({ waifuId, includePrivate }: { waifuId: string; includePrivate: boolean }) {
  const [root, setRoot] = useState<"home" | "tmp" | "transcripts">("home");
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<{ path: string; isNew?: boolean } | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [createNote, setCreateNote] = useState<string | undefined>(undefined);
  const newId = useId();
  const list = useApi<HerFilesList>((s) => api.herFiles(waifuId, { root, ...(dir ? { dir } : {}), includePrivate }, s), [waifuId, root, dir, includePrivate]);
  const data = list.error ? undefined : matchingReveal(list.data, includePrivate);

  const choose = (next: "home" | "tmp" | "transcripts") => {
    setRoot(next);
    setDir(undefined);
    setOpen(undefined);
  };
  const enter = (entry: HerFileEntry) => {
    if (!entry.path) return;
    if (entry.kind === "dir") {
      setDir(entry.path);
      setOpen(undefined);
    } else setOpen({ path: entry.path });
  };
  const createFile = () => {
    const name = newName.trim().replace(/^\/+/u, "");
    if (!name || !data) return;
    // A name already here (her disk ignores case) opens that file instead of replacing it.
    const existing = data.entries.find((entry) => entry.path !== undefined && entry.name.toLowerCase() === name.toLowerCase());
    if (existing?.path) {
      setCreateNote(`${existing.name} already exists; it is open below.`);
      if (existing.kind === "dir") setDir(existing.path);
      else setOpen({ path: existing.path });
    } else {
      setCreateNote(undefined);
      setOpen({ path: `${data.dir}/${name}`, isNew: true });
    }
    setNewName("");
  };

  return (
    <div className="cell cell-pad">
      <div className="cell-head">
        <span className="t-title">Her files</span>
        <button className="btn sm" aria-pressed={root === "home"} onClick={() => choose("home")}>
          Home
        </button>
        <button className="btn sm" aria-pressed={root === "tmp"} onClick={() => choose("tmp")}>
          /tmp
        </button>
        <button className="btn sm" aria-pressed={root === "transcripts"} onClick={() => choose("transcripts")}>
          Transcripts
        </button>
        {data && !data.usage && <span className="t-micro t-plain">read-only: everything said where she is, one file per place per day</span>}
        {data?.usage && (
          <span className="t-micro t-plain">
            {fileSize(data.usage.bytes)} of {fileSize(data.usage.maxBytes)}
            {data.usage.maxFiles !== undefined ? ` · ${data.usage.files} of ${data.usage.maxFiles} files` : ""}
            {data.usage.retentionDays !== undefined ? ` · files are deleted ${data.usage.retentionDays === 1 ? "a day" : `${data.usage.retentionDays} days`} after they were last written` : ""}
          </span>
        )}
      </div>
      {list.error && <Notice tone="err">Files: {list.error.message}</Notice>}
      {data && (
        <>
          <nav aria-label="Folder" className="t-small" style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "baseline", marginBottom: 4 }}>
            {breadcrumbs(data).map((crumb, index, all) => (
              <span key={crumb.dir} style={{ display: "inline-flex", gap: 4 }}>
                {index > 0 && <span className="t-mute">/</span>}
                {index === all.length - 1 ? (
                  <span className="mono">{crumb.label}</span>
                ) : (
                  <button className="btn quiet sm mono" onClick={() => { setDir(crumb.dir); setOpen(undefined); }}>
                    {crumb.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {data.entries.length === 0 && <div className="t-small t-mute" style={{ padding: "6px 0" }}>Empty.</div>}
          {data.entries.map((entry, index) => (
            <FileRow key={entry.path ?? `private-${index}`} entry={entry} selected={entry.path !== undefined && entry.path === open?.path} onOpen={() => enter(entry)} />
          ))}
          {data.root !== "transcripts" && <div className="soft-row" style={{ alignItems: "center" }}>
            <label className="t-micro" htmlFor={newId}>New text file here</label>
            <input id={newId} className="input" style={{ flex: "1 1 160px", minWidth: 0 }} placeholder="notes.md" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFile()} />
            <button className="btn sm" disabled={!newName.trim()} onClick={createFile}>
              Create
            </button>
          </div>}
          {createNote && <Notice tone="warn">{createNote}</Notice>}
        </>
      )}
      {open && (
        <FileViewer
          key={open.path}
          waifuId={waifuId}
          path={open.path}
          isNew={open.isNew === true}
          includePrivate={includePrivate}
          onClose={() => setOpen(undefined)}
          onChanged={(saved) => {
            list.reload();
            if (saved) setOpen({ path: saved });
          }}
        />
      )}
    </div>
  );
}

/** One entry: a folder or file to open, or a private one shown only as such. */
export function FileRow({ entry, selected, onOpen }: { entry: HerFileEntry; selected?: boolean; onOpen: () => void }) {
  const label = entry.kind === "dir" && !entry.redacted ? `${entry.name}/` : entry.name;
  return (
    <div className="soft-row">
      {entry.redacted ? (
        <span className="t-small t-mute" style={{ flex: "1 1 200px", overflowWrap: "anywhere" }}>
          {label} · reveal private chats on the host to open it
        </span>
      ) : (
        <button className="btn quiet sm mono" aria-current={selected ? "true" : undefined} style={{ flex: "1 1 200px", textAlign: "left", overflowWrap: "anywhere" }} onClick={onOpen}>
          {label}
        </button>
      )}
      <span className="t-micro" style={{ flex: "none" }}>{entryDetail(entry)}</span>
      <span className="t-micro" style={{ flex: "none" }}>{when(entry.modified)}</span>
      {entry.private && <span className="chip sky">private chat</span>}
    </div>
  );
}

/** One open file: a text editor (with the same checks as her Write tool), an image, or its facts. */
function FileViewer({
  waifuId,
  path,
  isNew,
  includePrivate,
  onClose,
  onChanged
}: {
  waifuId: string;
  path: string;
  isNew: boolean;
  includePrivate: boolean;
  onClose: () => void;
  onChanged: (savedPath?: string) => void;
}) {
  const file = useApi<HerFile | undefined>((s) => (isNew ? Promise.resolve(undefined) : api.herFile(waifuId, path, includePrivate, s)), [waifuId, path, isNew, includePrivate]);
  const shown = file.error ? undefined : file.data && file.data.includePrivate === includePrivate ? file.data : undefined;
  const [draft, setDraft] = useState<string | undefined>(isNew ? "" : undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const editorId = useId();

  // A fresh read (or a save) resets the draft to what is on disk.
  useEffect(() => {
    if (shown?.text !== undefined) setDraft(shown.text);
  }, [shown?.hash, shown?.text]);

  useEffect(() => {
    if (shown?.kind !== "image") return;
    const controller = new AbortController();
    let url: string | undefined;
    api
      .herFileBytes(waifuId, path, includePrivate, controller.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name !== "AbortError") setMessage({ tone: "err", text: (err as Error).message });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setImageUrl(undefined);
    };
  }, [shown?.kind, shown?.hash, waifuId, path, includePrivate]);

  const display = shown?.display ?? path;
  const editable = isNew || (shown?.text !== undefined && !shown.readOnly);
  const changed = draft !== undefined && (isNew || draft !== shown?.text);

  const save = async () => {
    if (draft === undefined) return;
    setBusy(true);
    setMessage(undefined);
    setConflicted(false);
    try {
      const result = await api.writeHerFile(waifuId, path, { text: draft, expectedHash: isNew ? null : (shown?.hash ?? null) }, includePrivate);
      setMessage({ tone: "ok", text: `Saved ${result.display} (${fileSize(result.size)})${result.rewritten ? "; new entries got their ids" : ""}.` });
      if (isNew) onChanged(result.path);
      else {
        onChanged();
        file.reload();
      }
    } catch (err) {
      // The server's own words: a JSON problem names its line and column. A change on disk since it
      // was opened (she wrote it, a reminder fired) offers to load the file again.
      const status = (err as { status?: number }).status;
      if (status === 409 || status === 428) {
        setConflicted(true);
        setMessage({ tone: "warn", text: isNew ? "A file with this name exists now; reload to open it (your text stays here until you do)." : "The file changed since you opened it. Reload to see it (your changes here are dropped), or copy them first." });
      } else setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await api.deleteHerFile(waifuId, path, shown?.hash, includePrivate);
      onChanged();
      onClose();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
      setBusy(false);
    }
  };

  const reloadFile = () => {
    setConflicted(false);
    setMessage(undefined);
    if (isNew) onChanged(path);
    else {
      setDraft(undefined);
      file.reload();
    }
  };

  return (
    <div className="soft-divider" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="mono t-small" style={{ overflowWrap: "anywhere", flex: "1 1 200px" }}>{display}</span>
        {shown && <span className="t-micro">{fileSize(shown.size)} · {when(shown.modified)}</span>}
        {shown?.private && <span className="chip sky">private chat</span>}
        <button className="btn quiet sm" onClick={onClose}>
          Close
        </button>
      </div>
      {file.error && <Notice tone="err">{file.error.message}</Notice>}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {conflicted && (
        <div>
          <button className="btn sm" onClick={reloadFile}>
            Reload
          </button>
        </div>
      )}
      {shown?.readOnly && !shown.redacted && <span className="t-small t-mute">Kept up to date by the app: she can read it, nobody changes it.</span>}
      {shown?.redacted && shown.special === "watches" && <span className="t-small t-mute">A watch here is bound to a private chat, so its words are hidden and the file can't be changed here; reveal private chats on the host to edit it.</span>}
      {shown?.redacted && shown.special !== "watches" && <span className="t-small t-mute">Lines from private chats are hidden, so the file can't be changed here; reveal private chats on the host to edit it.</span>}
      {shown?.special && <span className="t-small t-mute">Every save is checked; a problem is shown with its line and column and nothing is saved.</span>}
      {shown?.tooLarge && <span className="t-small t-mute">Too large to edit here.</span>}
      {(editable || shown?.text !== undefined) && draft !== undefined && (
        <>
          <label className="field-label" htmlFor={editorId}>
            {isNew ? "New file" : editable ? "Text" : "Text (read-only)"}
          </label>
          <textarea id={editorId} className="textarea mono" rows={14} spellCheck={false} readOnly={!editable} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: "100%", fontSize: 12.5 }} />
        </>
      )}
      {shown?.kind === "image" && (imageUrl ? <img src={imageUrl} alt={display} style={{ maxWidth: "100%", maxHeight: 420, objectFit: "contain", alignSelf: "flex-start" }} /> : <span className="t-small t-mute">Loading the picture…</span>)}
      {(shown?.kind === "pdf" || shown?.kind === "binary") && <span className="t-small t-mute">{shown.kind === "pdf" ? "A PDF: she reads its text with her Read tool." : "Not a text file."}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {editable && (
          <button className="btn primary sm" disabled={busy || !changed} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        )}
        {editable && changed && !isNew && shown?.text !== undefined && (
          <button className="btn quiet sm" disabled={busy} onClick={() => setDraft(shown.text)}>
            Revert
          </button>
        )}
        {!isNew && shown && !shown.readOnly && (
          <button ref={deleteButton} className="btn danger sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete…
          </button>
        )}
      </div>
      {confirmDelete && (
        <ConfirmDialog title={`Delete ${display}?`} cancelLabel="Keep" confirmLabel="Delete" returnFocus={() => deleteButton.current} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()}>
          <p className="t-small">It is gone from her folder for good.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Her reminders (`~/life/reminders.json`) and watches (`~/life/watches.json`), each with a delete button. */
export function PlansPanel({ waifuId, includePrivate }: { waifuId: string; includePrivate: boolean }) {
  const schedule = useApi<ScheduleResponse>((s) => api.schedule(waifuId, s), [waifuId]);
  const watches = useApi<WatchesResponse>((s) => api.watches(waifuId, includePrivate, s), [waifuId, includePrivate]);
  const watchData = watches.error ? undefined : matchingReveal(watches.data, includePrivate);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [pending, setPending] = useState<{ kind: "reminder" | "watch"; id: string } | undefined>(undefined);
  const returnTo = useRef<HTMLElement | null>(null);

  const drop = async (work: () => Promise<unknown>, reload: () => void) => {
    setMessage(undefined);
    try {
      await work();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      reload();
    }
  };
  const ask = (kind: "reminder" | "watch", id: string) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending({ kind, id });
  };
  const confirm = () => {
    const target = pending;
    setPending(undefined);
    if (!target) return;
    if (target.kind === "reminder") void drop(() => api.deleteReminder(waifuId, target.id), schedule.reload);
    else void drop(() => api.deleteWatch(waifuId, target.id), watches.reload);
  };
  const refresh = () => {
    setMessage(undefined);
    schedule.reload();
    watches.reload();
  };

  return (
    <div className="cell cell-pad">
      <div className="cell-head">
        <span className="t-title">Reminders and watches</span>
        <button className="btn quiet sm" onClick={refresh}>
          Refresh
        </button>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <ReminderList data={schedule.error ? undefined : schedule.data} error={schedule.error?.message} onDelete={(id) => ask("reminder", id)} />
      <WatchList data={watchData} includePrivate={includePrivate} error={watches.error?.message} onDelete={(id) => ask("watch", id)} />
      {pending && (
        <ConfirmDialog
          title={`Delete ${pending.kind} ${pending.id}?`}
          cancelLabel="Keep"
          confirmLabel="Delete"
          returnFocus={() => returnTo.current}
          onCancel={() => setPending(undefined)}
          onConfirm={confirm}
        >
          <p className="t-small">{pending.kind === "reminder" ? "It is removed from her life/reminders.json and won't wake her." : "It is removed from her life/watches.json; she is not told."}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function ReminderList({ data, error, onDelete }: { data: ScheduleResponse | undefined; error?: string; onDelete: (id: string) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="t-micro" style={{ marginBottom: 4 }}>Reminders{data ? ` (${data.timeZone})` : ""}</div>
      {error && <Notice tone="err">Reminders: {error}</Notice>}
      {data?.unreadable && <Notice tone="warn">Her life/reminders.json does not read cleanly; fix it in her files (only the entries below were understood).</Notice>}
      {data && data.entries.length === 0 && <span className="t-small t-mute">None. She sets them with ScheduleWake, or by editing life/reminders.json.</span>}
      {data?.entries.map((entry) => (
        <div key={entry.id} className="soft-row">
          <span className="t-micro" style={{ flex: "none" }}>{entry.id}</span>
          <span className="mono t-small" style={{ flex: "none" }}>{entry.at}</span>
          {entry.repeat && <span className="chip lavender">{entry.repeat}</span>}
          <span className="t-small" style={{ flex: "1 1 200px", overflowWrap: "anywhere" }}>{entry.note}</span>
          <button className="btn quiet sm" aria-label={`Delete reminder ${entry.id}`} onClick={() => onDelete(entry.id)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

export function WatchList({ data, includePrivate, error, onDelete }: { data: WatchesResponse | undefined; includePrivate: boolean; error?: string; onDelete: (id: string) => void }) {
  return (
    <div>
      <div className="t-micro" style={{ marginBottom: 4 }}>Watches{data ? ` (${data.timeZone})` : ""}</div>
      {error && <Notice tone="err">Watches: {error}</Notice>}
      {data?.unreadable && <Notice tone="warn">Her life/watches.json does not read cleanly; fix it in her files (only the entries below were understood).</Notice>}
      {data && data.entries.length === 0 && <span className="t-small t-mute">None. She sets them with WatchFor, or by editing life/watches.json.</span>}
      {data?.entries.map((entry) => {
        const hidden = entry.private === true && !includePrivate;
        return (
          <div key={entry.id} className="soft-row">
            <span className="t-micro" style={{ flex: "none" }}>{entry.id}</span>
            <span className="mono t-small" style={{ flex: "none" }}>until {entry.timeout}</span>
            {!entry.once && <span className="chip lavender">repeats</span>}
            <span className="t-small" style={{ flex: "1 1 200px", overflowWrap: "anywhere" }}>
              {hidden ? <span className="t-mute">{PRIVATE_HIDDEN}</span> : `${watchWhenText(entry)} · ${entry.note}`}
            </span>
            {entry.private && <span className="chip sky">private chat</span>}
            <button className="btn quiet sm" aria-label={`Delete watch ${entry.id}`} onClick={() => onDelete(entry.id)}>
              Delete
            </button>
          </div>
        );
      })}
    </div>
  );
}
