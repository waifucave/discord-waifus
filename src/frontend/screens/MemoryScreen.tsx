import { useMemo, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { MemoryRecord, MemoryStore, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { FootRow, HeadRow } from "./scaffold";
import { Notice } from "../components/Notice";

const KIND_HUES: Record<string, string> = {
  fact: "mint",
  preference: "sky",
  event: "lavender",
  commitment: "peach",
  context: "pink",
  note: "butter"
};

export function MemoryScreen({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const store = useApi<MemoryStore>((s) => api.memories(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const [waifuFilter, setWaifuFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newWaifuId, setNewWaifuId] = useState("");
  const [newGuildId, setNewGuildId] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [editContent, setEditContent] = useState("");

  const records = useMemo(() => {
    const all = (store.data?.memories ?? []).filter((m) => m.status !== "archived");
    const q = query.trim().toLowerCase();
    return all
      .filter((m) => (waifuFilter ? m.waifuId === waifuFilter : true))
      .filter((m) => (kindFilter ? m.kind === kindFilter : true))
      .filter((m) => (q ? m.content.toLowerCase().includes(q) : true))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 200);
  }, [store.data, waifuFilter, kindFilter, query]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMessage(undefined);
      store.reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const togglePin = (record: MemoryRecord) =>
    act(() => api.updateMemory(record.id, { revision: store.data!.revision, pinned: !record.pinned }));
  const remove = (record: MemoryRecord) => act(() => api.deleteMemory(record.id, store.data!.revision));
  const saveEdit = (record: MemoryRecord) =>
    act(async () => {
      await api.updateMemory(record.id, { revision: store.data!.revision, content: editContent });
      setEditingId(undefined);
    });
  const add = () =>
    act(async () => {
      await api.createMemory({ waifuId: newWaifuId, guildId: newGuildId || "global", content: newContent, pinned: true });
      setAdding(false);
      setNewContent("");
    });

  const cast = waifus.data?.waifus ?? [];

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("home")}
        title="Memory"
        sub={`${records.length} shown · pinned never decay`}
        action={
          <button className="cell clickable actioncell" data-hue style={{ ["--hover-hue" as string]: "var(--butter)" }} onClick={() => setAdding((v) => !v)}>
            + New memory
          </button>
        }
      />
      <div style={{ display: "grid", gridTemplateColumns: "220px 200px 1fr", gap: "var(--line)", background: "var(--ink)", flex: "none" }}>
        <select className="cell select" style={{ border: "none", height: 56 }} value={waifuFilter} onChange={(e) => setWaifuFilter(e.target.value)}>
          <option value="">All characters</option>
          {cast.map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName || w.name}
            </option>
          ))}
        </select>
        <select className="cell select" style={{ border: "none", height: 56 }} value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">All kinds</option>
          {Object.keys(KIND_HUES).map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <input
          className="cell input"
          style={{ border: "none", height: 56 }}
          placeholder="Search content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="content">
        {message && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="err">{message}</Notice>
          </div>
        )}
        {adding && (
          <div className="cell formcell" style={{ flex: "none" }}>
            <div className="frow" style={{ gridTemplateColumns: "220px 220px 1fr" }}>
              <div className="field">
                <label className="field-label">Character</label>
                <select className="select" value={newWaifuId} onChange={(e) => setNewWaifuId(e.target.value)}>
                  <option value="">pick…</option>
                  {cast.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.displayName || w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">Guild id</label>
                <input className="input" value={newGuildId} onChange={(e) => setNewGuildId(e.target.value)} placeholder="from Rooms" />
              </div>
              <div className="field">
                <label className="field-label">Content</label>
                <input className="input" value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder="K prefers green tea" />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn primary" onClick={add} disabled={!newWaifuId || !newContent.trim()}>
                Add pinned memory
              </button>
              <button className="btn ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {records.map((record) => (
          <div className="cell" style={{ padding: "14px 26px", flex: "none" }} key={record.id}>
            <div className="t-micro" style={{ marginBottom: 5 }}>
              {record.waifuId} · <span className={"chip " + (KIND_HUES[record.kind] ?? "butter")}>{record.kind}</span>
              {record.pinned && <span className="chip butter" style={{ marginLeft: 6 }}>pinned</span>}
              <span style={{ float: "right" }}>
                <button className="icon-btn t-micro" onClick={() => togglePin(record)}>{record.pinned ? "unpin" : "pin"}</button>
                <button
                  className="icon-btn t-micro"
                  onClick={() => {
                    setEditingId(record.id);
                    setEditContent(record.content);
                  }}
                >
                  edit
                </button>
                <button className="icon-btn t-micro" style={{ color: "#c22f2f" }} onClick={() => remove(record)}>
                  delete
                </button>
              </span>
            </div>
            {editingId === record.id ? (
              <div style={{ display: "flex", gap: 10 }}>
                <input className="input" value={editContent} onChange={(e) => setEditContent(e.target.value)} />
                <button className="btn primary" onClick={() => saveEdit(record)}>
                  Save
                </button>
                <button className="btn ghost" onClick={() => setEditingId(undefined)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="t-small" style={{ lineHeight: 1.5 }}>{record.content}</div>
            )}
          </div>
        ))}
        {records.length === 0 && (
          <div className="cell growcell" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="t-mute t-small">No memories match — the stage manager fills this as your server talks.</span>
          </div>
        )}
        <div className="cell growcell" />
      </div>
      <FootRow />
    </div>
  );
}
