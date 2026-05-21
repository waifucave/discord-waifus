import { useMemo, useState } from "react";
import { Archive, Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ConflictError } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  MemoryImportance,
  MemoryStatus,
  MemoryStore,
  ServersResponse,
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

export function MemoriesView() {
  const memories = useApi<MemoryStore>((s) => api.memories(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);

  const [filterWaifu, setFilterWaifu] = useState<string>("");
  const [filterGuild, setFilterGuild] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [filterImportance, setFilterImportance] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");

  const [editing, setEditing] = useState<WaifuMemory | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [conflictLatest, setConflictLatest] = useState<MemoryStore | undefined>(undefined);

  const filtered = useMemo(() => {
    const all = memories.data?.memories ?? [];
    return all.filter((m) => {
      if (filterWaifu && m.waifuId !== filterWaifu) return false;
      if (filterGuild && m.guildId !== filterGuild) return false;
      if (filterStatus && m.status !== filterStatus) return false;
      if (filterImportance && String(m.importance) !== filterImportance) return false;
      if (filterText && !m.content.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
  }, [memories.data, filterWaifu, filterGuild, filterStatus, filterImportance, filterText]);

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
          <button className="btn" onClick={memories.reload}>Refresh</button>
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
                <th>Importance</th>
                <th>Status</th>
                <th>Content</th>
                <th>Source msgs</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td>
                    {(waifus.data?.waifus.find((w) => w.id === m.waifuId)?.displayName) || m.waifuId}
                  </td>
                  <td>
                    <Pill>{serverLabel(servers.data?.servers ?? [], m.guildId)}</Pill>
                  </td>
                  <td>★ {m.importance}</td>
                  <td>
                    {m.status === "active" ? (
                      <Pill tone="ok" dot>active</Pill>
                    ) : (
                      <Pill tone="neutral" dot>archived</Pill>
                    )}
                  </td>
                  <td className="wrap" style={{ maxWidth: 480 }}>
                    <div style={{ whiteSpace: "normal", overflow: "hidden" }}>{m.content}</div>
                  </td>
                  <td>
                    {m.sourceMessageIds.length === 0 ? (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    ) : (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
                        {m.sourceMessageIds.length} id{m.sourceMessageIds.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td>{timeAgo(m.updatedAt)}</td>
                  <td className="right">
                    <div className="cell-actions">
                      <button className="btn sm" onClick={() => setEditing(m)}>
                        <Pencil className="icon" /> Edit
                      </button>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          if (!memories.data) return;
                          try {
                            const next = await api.updateMemory(m.id, {
                              revision: memories.data.revision,
                              status: m.status === "active" ? "archived" : "active"
                            });
                            memories.setData(next);
                          } catch (err) {
                            if (err instanceof ConflictError) {
                              setConflictLatest(err.latest as MemoryStore);
                            }
                          }
                        }}
                      >
                        <Archive className="icon" />
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={async () => {
                          if (!memories.data) return;
                          if (!window.confirm("Delete this memory?")) return;
                          try {
                            const next = await api.deleteMemory(m.id, memories.data.revision);
                            memories.setData(next);
                          } catch (err) {
                            if (err instanceof ConflictError) {
                              setConflictLatest(err.latest as MemoryStore);
                            }
                          }
                        }}
                      >
                        <Trash2 className="icon" />
                      </button>
                    </div>
                  </td>
                </tr>
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

function serverLabel(servers: ServersResponse["servers"], guildId?: string): string {
  if (!guildId) return "unassigned";
  return servers.find((server) => server.guildId === guildId)?.name || guildId;
}
