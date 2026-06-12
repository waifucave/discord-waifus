import { useEffect, useMemo, useState } from "react";
import { Archive, Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ConflictError } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  MemoryKind,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  MemoryStore,
  ServersResponse,
  WaifusResponse
} from "../api/types";
import { MEMORY_KINDS, MEMORY_SOURCES } from "../api/types";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { SkeletonRows } from "../components/Skeleton";
import { timeAgo } from "../utils/format";

const STATUSES: MemoryStatus[] = ["active", "archived"];
const STRENGTHS = [1, 2, 3, 4, 5];
const STRENGTHS_DESC = [...STRENGTHS].reverse();

export function MemoriesView() {
  const memories = useApi<MemoryStore>((s) => api.memories(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);

  const [filterWaifu, setFilterWaifu] = useState<string>("");
  const [filterGuild, setFilterGuild] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [filterStrength, setFilterStrength] = useState<string>("");
  const [filterKind, setFilterKind] = useState<string>("");
  const [filterSource, setFilterSource] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");

  const [editing, setEditing] = useState<MemoryRecord | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [conflictLatest, setConflictLatest] = useState<MemoryStore | undefined>(undefined);

  // Tick once a minute so countdown timers refresh while the tab is open.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = useMemo<MemoryRecord[]>(() => memories.data?.memories ?? [], [memories.data]);

  const filtered = useMemo(() => {
    return rows.filter((memory) => {
      if (filterWaifu && memory.waifuId !== filterWaifu) return false;
      if (filterText && !memory.content.toLowerCase().includes(filterText.toLowerCase())) return false;
      if (filterGuild && memory.guildId !== filterGuild) return false;
      if (filterStatus && memory.status !== filterStatus) return false;
      if (filterKind && memory.kind !== filterKind) return false;
      if (filterSource && memory.source !== filterSource) return false;
      if (filterStrength === "pinned" && !memory.pinned) return false;
      if (
        filterStrength &&
        filterStrength !== "pinned" &&
        (memory.pinned || String(Math.round(memory.strength)) !== filterStrength)
      ) return false;
      return true;
    });
  }, [rows, filterWaifu, filterGuild, filterStatus, filterStrength, filterKind, filterSource, filterText]);

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Memories</h2>
          <p className="view-subtitle">
            Per-waifu guild memory store. Pinned memories are user-managed and never auto-edited.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={() => memories.reload()}>
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

      <div className="toolbar">
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
        <select className="select" value={filterStrength} onChange={(e) => setFilterStrength(e.target.value)} style={{ maxWidth: 140 }}>
          <option value="">Any strength</option>
          <option value="pinned">📌 Pinned</option>
          {STRENGTHS_DESC.map((i) => (
            <option key={i} value={String(i)}>
              ★ {i}
            </option>
          ))}
        </select>
        <select className="select" value={filterKind} onChange={(e) => setFilterKind(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">Any kind</option>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select className="select" value={filterSource} onChange={(e) => setFilterSource(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">Any source</option>
          {MEMORY_SOURCES.map((s) => (
            <option key={s} value={s}>{sourceLabel(s)}</option>
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

      {memories.loading && <SkeletonRows rows={6} />}
      {memories.error && <Notice tone="err">{memories.error.message}</Notice>}

      {memories.data && filtered.length === 0 && (
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
                <th>Strength</th>
                <th>Kind</th>
                <th>Source</th>
                <th>Status</th>
                <th>Content</th>
                <th>Expires</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((memory) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  waifus={waifus.data?.waifus ?? []}
                  servers={servers.data?.servers ?? []}
                  storeRevision={memories.data?.revision ?? 0}
                  onEdit={() => setEditing(memory)}
                  onUpdated={(next) => memories.setData(next)}
                  onConflict={(latest) => setConflictLatest(latest)}
                />
              ))}
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

      {editing && (
        <MemoryEditor
          mode="edit"
          waifus={waifus.data?.waifus ?? []}
          servers={servers.data?.servers ?? []}
          revision={memories.data?.revision ?? 0}
          memory={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(store, conflict) => {
            if (conflict) setConflictLatest(conflict);
            if (store) memories.setData(store);
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}

function MemoryRow({
  memory,
  waifus,
  servers,
  storeRevision,
  onEdit,
  onUpdated,
  onConflict
}: {
  memory: MemoryRecord;
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
      <td>{memory.pinned ? "📌 Pinned" : `★ ${Math.round(memory.strength)}`}</td>
      <td><Pill tone="info">{memory.kind}</Pill></td>
      <td><Pill tone={sourceTone(memory.source)}>{sourceLabel(memory.source)}</Pill></td>
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
        {memory.expiresAt ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
            {formatExpiresIn(memory.expiresAt)}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
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
  memory?: MemoryRecord;
  onClose: () => void;
  onSaved: (store: MemoryStore | undefined, conflict: MemoryStore | undefined) => void;
}) {
  const [waifuId, setWaifuId] = useState(memory?.waifuId ?? waifus[0]?.id ?? "");
  const [guildId, setGuildId] = useState(memory?.guildId ?? servers[0]?.guildId ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [strength, setStrength] = useState<number>(memory ? Math.round(memory.strength) : 5);
  const [pinned, setPinned] = useState(memory?.pinned ?? true);
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "fact");
  const [status, setStatus] = useState<MemoryStatus>(memory?.status ?? "active");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (!waifuId || !guildId || !content.trim()) {
      setErr("Waifu, guild, and content are required.");
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      if (mode === "create") {
        const next = await api.createMemory({
          revision,
          waifuId,
          guildId,
          content: content.trim(),
          strength,
          pinned,
          kind
        });
        onSaved(next, undefined);
      } else if (memory) {
        const next = await api.updateMemory(memory.id, {
          revision,
          waifuId,
          guildId,
          content: content.trim(),
          strength,
          pinned,
          kind,
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
          <label className="field-label">Strength / retention</label>
          <select
            className="select"
            value={pinned ? "pinned" : String(strength)}
            onChange={(e) => {
              if (e.target.value === "pinned") {
                setPinned(true);
                return;
              }
              setPinned(false);
              setStrength(Number(e.target.value));
            }}
          >
            <option value="pinned">📌 Pinned</option>
            {STRENGTHS_DESC.map((i) => (
              <option key={i} value={String(i)}>
                ★ {i}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Pinned memories stay in the waifu prompt, are never auto-edited, and can only be managed from this dashboard.
          </span>
        </div>
        <div className="field">
          <label className="field-label">Kind</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
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
      {err && <Notice tone="err">{err}</Notice>}
    </Modal>
  );
}

function serverLabel(servers: ServersResponse["servers"], guildId?: string): string {
  if (!guildId) return "unassigned";
  return servers.find((server) => server.guildId === guildId)?.name || guildId;
}

function sourceLabel(source: MemorySource): string {
  switch (source) {
    case "waifu_tool": return "waifu";
    case "stage_manager": return "observer";
    case "dream": return "dream";
    case "user": return "user";
  }
}

function sourceTone(source: MemorySource): import("../components/Pill").PillTone {
  switch (source) {
    case "waifu_tool": return "warn";
    case "stage_manager": return "neutral";
    case "dream": return "info";
    case "user": return "ok";
  }
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
