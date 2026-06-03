import { useEffect, useMemo, useState } from "react";
import { Archive, Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ConflictError } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  MemoryImportance,
  MemoryStatus,
  MemoryStore,
  ServersResponse,
  ShortTermMemory,
  ShortTermMemoryStore,
  WaifuMemory,
  WaifusResponse
} from "../api/types";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { SkeletonRows } from "../components/Skeleton";
import { timeAgo } from "../utils/format";

const STATUSES: MemoryStatus[] = ["active", "archived"];
const IMPORTANCES: MemoryImportance[] = [1, 2, 3, 4, 5];

type TypeFilter = "" | "long-term" | "short-term";

type UnifiedRow =
  | { kind: "long-term"; data: WaifuMemory }
  | { kind: "short-term"; data: ShortTermMemory };

export function MemoriesView() {
  const memories = useApi<MemoryStore>((s) => api.memories(s), []);
  const shortTerm = useApi<ShortTermMemoryStore>((s) => api.shortTermMemories(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);

  const [filterWaifu, setFilterWaifu] = useState<string>("");
  const [filterGuild, setFilterGuild] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [filterImportance, setFilterImportance] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");
  const [filterType, setFilterType] = useState<TypeFilter>("");

  const [editingLong, setEditingLong] = useState<WaifuMemory | undefined>(undefined);
  const [editingShort, setEditingShort] = useState<ShortTermMemory | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [conflictLatest, setConflictLatest] = useState<MemoryStore | undefined>(undefined);
  const [shortConflictLatest, setShortConflictLatest] = useState<ShortTermMemoryStore | undefined>(undefined);

  // Tick once a minute so countdown timers refresh while the tab is open.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = useMemo<UnifiedRow[]>(() => {
    const long: UnifiedRow[] = (memories.data?.memories ?? []).map((m) => ({ kind: "long-term", data: m }));
    const short: UnifiedRow[] = (shortTerm.data?.entries ?? []).map((e) => ({ kind: "short-term", data: e }));
    return [...long, ...short];
  }, [memories.data, shortTerm.data]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (filterType && row.kind !== filterType) return false;
      if (filterWaifu && row.data.waifuId !== filterWaifu) return false;
      if (filterText && !row.data.content.toLowerCase().includes(filterText.toLowerCase())) return false;
      if (row.kind === "long-term") {
        if (filterGuild && row.data.guildId !== filterGuild) return false;
        if (filterStatus && row.data.status !== filterStatus) return false;
        if (filterImportance && String(row.data.importance) !== filterImportance) return false;
      } else {
        if (filterGuild && row.data.guildId !== filterGuild) return false;
        // Short-term entries are always live (expired ones already pruned by the backend);
        // treat them as "active" for the status filter and excluded by any importance filter.
        if (filterStatus && filterStatus !== "active") return false;
        if (filterImportance) return false;
      }
      return true;
    });
  }, [rows, filterType, filterWaifu, filterGuild, filterStatus, filterImportance, filterText]);

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Memories</h2>
          <p className="view-subtitle">
            Per-waifu guild memory store. Shared with the stage manager; writes use the same revision lock.
          </p>
        </div>
        <div className="view-actions">
          <button
            className="btn"
            onClick={() => {
              memories.reload();
              shortTerm.reload();
            }}
          >
            Refresh
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus className="icon" /> New memory
          </button>
        </div>
      </div>

      {conflictLatest && (
        <Notice tone="warn" title="Memory store changed during your edit">
          The server returned 409 with the latest snapshot.{" "}
          <button
            className="btn sm"
            onClick={() => {
              memories.setData(conflictLatest);
              setConflictLatest(undefined);
            }}
          >
            Apply latest
          </button>
        </Notice>
      )}

      {shortConflictLatest && (
        <Notice tone="warn" title="Short-term store changed during your edit">
          The server returned 409 with the latest snapshot.{" "}
          <button
            className="btn sm"
            onClick={() => {
              shortTerm.setData(shortConflictLatest);
              setShortConflictLatest(undefined);
            }}
          >
            Apply latest
          </button>
        </Notice>
      )}

      <div className="toolbar">
        <select
          className="select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as TypeFilter)}
          style={{ maxWidth: 160 }}
        >
          <option value="">All types</option>
          <option value="long-term">Long-term</option>
          <option value="short-term">Short-term</option>
        </select>
        <select className="select" value={filterWaifu} onChange={(e) => setFilterWaifu(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All waifus</option>
          {(waifus.data?.waifus ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName}
            </option>
          ))}
        </select>
        <select className="select" value={filterGuild} onChange={(e) => setFilterGuild(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All guilds</option>
          {(servers.data?.servers ?? []).map((s) => (
            <option key={s.guildId} value={s.guildId}>
              {s.name || s.guildId}
            </option>
          ))}
        </select>
        <select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ maxWidth: 140 }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="select" value={filterImportance} onChange={(e) => setFilterImportance(e.target.value)} style={{ maxWidth: 140 }}>
          <option value="">Any importance</option>
          {IMPORTANCES.map((i) => (
            <option key={i} value={String(i)}>
              ★ {i}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Search content…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
      </div>

      {(memories.loading || shortTerm.loading) && <SkeletonRows rows={6} />}
      {memories.error && <Notice tone="err">{memories.error.message}</Notice>}
      {shortTerm.error && <Notice tone="err">{shortTerm.error.message}</Notice>}

      {memories.data && shortTerm.data && filtered.length === 0 && (
        <Empty title="No memories match" icon={<Brain className="icon-lg" />}>
          Adjust filters, or add a memory manually. Stage-manager edits will land here as well.
        </Empty>
      )}

      {filtered.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Waifu</th>
                <th>Guild</th>
                <th>Importance</th>
                <th>Status</th>
                <th>Content</th>
                <th>Expires</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) =>
                row.kind === "long-term" ? (
                  <LongTermRow
                    key={`l-${row.data.id}`}
                    memory={row.data}
                    waifus={waifus.data?.waifus ?? []}
                    servers={servers.data?.servers ?? []}
                    storeRevision={memories.data?.revision ?? 0}
                    onEdit={() => setEditingLong(row.data)}
                    onUpdated={(next) => memories.setData(next)}
                    onConflict={(latest) => setConflictLatest(latest)}
                  />
                ) : (
                  <ShortTermRow
                    key={`s-${row.data.id}`}
                    entry={row.data}
                    waifus={waifus.data?.waifus ?? []}
                    servers={servers.data?.servers ?? []}
                    storeRevision={shortTerm.data?.revision ?? 0}
                    onEdit={() => setEditingShort(row.data)}
                    onUpdated={(next) => shortTerm.setData(next)}
                    onConflict={(latest) => setShortConflictLatest(latest)}
                  />
                )
              )}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <MemoryEditor
          mode="create"
          waifus={waifus.data?.waifus ?? []}
          servers={servers.data?.servers ?? []}
          revision={memories.data?.revision ?? 0}
          onClose={() => setCreating(false)}
          onSaved={(store, conflict) => {
            if (conflict) setConflictLatest(conflict);
            if (store) memories.setData(store);
            setCreating(false);
          }}
        />
      )}

      {editingLong && (
        <MemoryEditor
          mode="edit"
          waifus={waifus.data?.waifus ?? []}
          servers={servers.data?.servers ?? []}
          revision={memories.data?.revision ?? 0}
          memory={editingLong}
          onClose={() => setEditingLong(undefined)}
          onSaved={(store, conflict) => {
            if (conflict) setConflictLatest(conflict);
            if (store) memories.setData(store);
            setEditingLong(undefined);
          }}
        />
      )}

      {editingShort && (
        <ShortTermMemoryEditor
          waifus={waifus.data?.waifus ?? []}
          revision={shortTerm.data?.revision ?? 0}
          entry={editingShort}
          onClose={() => setEditingShort(undefined)}
          onSaved={(store, conflict) => {
            if (conflict) setShortConflictLatest(conflict);
            if (store) shortTerm.setData(store);
            setEditingShort(undefined);
          }}
        />
      )}
    </>
  );
}

function LongTermRow({
  memory,
  waifus,
  servers,
  storeRevision,
  onEdit,
  onUpdated,
  onConflict
}: {
  memory: WaifuMemory;
  waifus: WaifusResponse["waifus"];
  servers: ServersResponse["servers"];
  storeRevision: number;
  onEdit: () => void;
  onUpdated: (next: MemoryStore) => void;
  onConflict: (latest: MemoryStore) => void;
}) {
  return (
    <tr>
      <td>{waifus.find((w) => w.id === memory.waifuId)?.displayName || memory.waifuId}</td>
      <td>
        <Pill>{serverLabel(servers, memory.guildId)}</Pill>
      </td>
      <td>★ {memory.importance}</td>
      <td>
        {memory.status === "active" ? (
          <Pill tone="ok" dot>active</Pill>
        ) : (
          <Pill tone="neutral" dot>archived</Pill>
        )}
      </td>
      <td className="wrap" style={{ maxWidth: 480 }}>
        <div style={{ whiteSpace: "normal", overflow: "hidden" }}>{memory.content}</div>
      </td>
      <td>
        <span style={{ color: "var(--text-muted)" }}>—</span>
      </td>
      <td>{timeAgo(memory.updatedAt)}</td>
      <td className="right">
        <div className="cell-actions">
          <button className="btn sm" onClick={onEdit}>
            <Pencil className="icon" /> Edit
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              try {
                const next = await api.updateMemory(memory.id, {
                  revision: storeRevision,
                  status: memory.status === "active" ? "archived" : "active"
                });
                onUpdated(next);
              } catch (err) {
                if (err instanceof ConflictError) {
                  onConflict(err.latest as MemoryStore);
                }
              }
            }}
          >
            <Archive className="icon" />
          </button>
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!window.confirm("Delete this memory?")) return;
              try {
                const next = await api.deleteMemory(memory.id, storeRevision);
                onUpdated(next);
              } catch (err) {
                if (err instanceof ConflictError) {
                  onConflict(err.latest as MemoryStore);
                }
              }
            }}
          >
            <Trash2 className="icon" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function ShortTermRow({
  entry,
  waifus,
  servers,
  storeRevision,
  onEdit,
  onUpdated,
  onConflict
}: {
  entry: ShortTermMemory;
  waifus: WaifusResponse["waifus"];
  servers: ServersResponse["servers"];
  storeRevision: number;
  onEdit: () => void;
  onUpdated: (next: ShortTermMemoryStore) => void;
  onConflict: (latest: ShortTermMemoryStore) => void;
}) {
  return (
    <tr>
      <td>{waifus.find((w) => w.id === entry.waifuId)?.displayName || entry.waifuId}</td>
      <td>
        <Pill>{serverLabel(servers, entry.guildId)}</Pill>
      </td>
      <td>
        <span style={{ color: "var(--text-muted)" }}>—</span>
      </td>
      <td>
        <span style={{ color: "var(--text-muted)" }}>—</span>
      </td>
      <td className="wrap" style={{ maxWidth: 480 }}>
        <div style={{ whiteSpace: "normal", overflow: "hidden" }}>{entry.content}</div>
      </td>
      <td>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
          {formatExpiresIn(entry.expiresAt)}
        </span>
      </td>
      <td>{timeAgo(entry.createdAt)}</td>
      <td className="right">
        <div className="cell-actions">
          <button className="btn sm" onClick={onEdit}>
            <Pencil className="icon" /> Edit
          </button>
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!window.confirm("Delete this short-term memory?")) return;
              try {
                const next = await api.deleteShortTermMemory(entry.id, storeRevision);
                onUpdated(next);
              } catch (err) {
                if (err instanceof ConflictError) {
                  onConflict(err.latest as ShortTermMemoryStore);
                }
              }
            }}
          >
            <Trash2 className="icon" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function MemoryEditor({
  mode,
  waifus,
  servers,
  revision,
  memory,
  onClose,
  onSaved
}: {
  mode: "create" | "edit";
  waifus: WaifusResponse["waifus"];
  servers: ServersResponse["servers"];
  revision: number;
  memory?: WaifuMemory;
  onClose: () => void;
  onSaved: (store: MemoryStore | undefined, conflict: MemoryStore | undefined) => void;
}) {
  const [waifuId, setWaifuId] = useState(memory?.waifuId ?? waifus[0]?.id ?? "");
  const [guildId, setGuildId] = useState(memory?.guildId ?? servers[0]?.guildId ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [importance, setImportance] = useState<MemoryImportance>(memory?.importance ?? 3);
  const [status, setStatus] = useState<MemoryStatus>(memory?.status ?? "active");
  const [sources, setSources] = useState((memory?.sourceMessageIds ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (!waifuId || !guildId || !content.trim()) {
      setErr("Waifu, guild, and content are required.");
      return;
    }
    setBusy(true);
    setErr(undefined);
    const sourceMessageIds = sources
      .split(/[,\n\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (mode === "create") {
        const next = await api.createMemory({
          revision,
          waifuId,
          guildId,
          content: content.trim(),
          importance,
          sourceMessageIds
        });
        onSaved(next, undefined);
      } else if (memory) {
        const next = await api.updateMemory(memory.id, {
          revision,
          waifuId,
          guildId,
          content: content.trim(),
          importance,
          sourceMessageIds,
          status
        });
        onSaved(next, undefined);
      }
    } catch (e) {
      if (e instanceof ConflictError) {
        onSaved(undefined, e.latest as MemoryStore);
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      wide
      title={mode === "create" ? "New memory" : "Edit memory"}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label">Waifu</label>
          <select className="select" value={waifuId} onChange={(e) => setWaifuId(e.target.value)}>
            <option value="">— Select —</option>
            {waifus.map((w) => (
              <option key={w.id} value={w.id}>
                {w.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Guild</label>
          <select className="select" value={guildId} onChange={(e) => setGuildId(e.target.value)}>
            <option value="">— Select —</option>
            {servers.map((s) => (
              <option key={s.guildId} value={s.guildId}>
                {s.name || s.guildId}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Importance</label>
          <select
            className="select"
            value={String(importance)}
            onChange={(e) => setImportance(Number(e.target.value) as MemoryImportance)}
          >
            {IMPORTANCES.map((i) => (
              <option key={i} value={String(i)}>
                ★ {i}
              </option>
            ))}
          </select>
        </div>
        {mode === "edit" && (
          <div className="field">
            <label className="field-label">Status</label>
            <select
              className="select"
              value={status}
              onChange={(e) => setStatus(e.target.value as MemoryStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label className="field-label">Content</label>
        <textarea
          className="textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
        />
      </div>
      <div className="field">
        <label className="field-label">Source message ids</label>
        <textarea
          className="textarea"
          value={sources}
          onChange={(e) => setSources(e.target.value)}
          rows={3}
          placeholder="Comma- or newline-separated Discord message ids"
        />
        <span className="field-hint">
          Optional but useful when the stage manager surfaces a memory based on real messages.
        </span>
      </div>
      {err && <Notice tone="err">{err}</Notice>}
    </Modal>
  );
}

function ShortTermMemoryEditor({
  waifus,
  revision,
  entry,
  onClose,
  onSaved
}: {
  waifus: WaifusResponse["waifus"];
  revision: number;
  entry: ShortTermMemory;
  onClose: () => void;
  onSaved: (store: ShortTermMemoryStore | undefined, conflict: ShortTermMemoryStore | undefined) => void;
}) {
  const [waifuId, setWaifuId] = useState(entry.waifuId);
  const [content, setContent] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (!waifuId || !content.trim()) {
      setErr("Waifu and content are required.");
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      const next = await api.updateShortTermMemory(entry.id, {
        revision,
        waifuId,
        content: content.trim()
      });
      onSaved(next, undefined);
    } catch (e) {
      if (e instanceof ConflictError) {
        onSaved(undefined, e.latest as ShortTermMemoryStore);
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      wide
      title="Edit short-term memory"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">Waifu</label>
        <select className="select" value={waifuId} onChange={(e) => setWaifuId(e.target.value)}>
          <option value="">— Select —</option>
          {waifus.map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label">Content</label>
        <textarea
          className="textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
        />
        <span className="field-hint">
          Expires {formatExpiresIn(entry.expiresAt)} from now. Editing does not reset the timer.
        </span>
      </div>
      {err && <Notice tone="err">{err}</Notice>}
    </Modal>
  );
}

function serverLabel(servers: ServersResponse["servers"], guildId?: string): string {
  if (!guildId) return "unassigned";
  return servers.find((server) => server.guildId === guildId)?.name || guildId;
}

function formatExpiresIn(expiresAt: string): string {
  const diff = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return "expired";
  const totalMin = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours >= 1) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}
