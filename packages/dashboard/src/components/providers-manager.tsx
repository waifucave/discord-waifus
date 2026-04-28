"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Network, PlugZap, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ProviderConfig, WaifuEditorPayload } from "@/lib/types";
import { Panel, Button, Input, Label, Textarea, Select, Badge } from "./ui";
import { useToast } from "./toast-provider";

const providerTemplates: Record<string, Partial<ProviderConfig>> = {
  openai: {
    id: "",
    name: "OpenAI",
    origin: "custom",
    authMode: "required",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1"
  },
  anthropic: {
    id: "",
    name: "Anthropic",
    origin: "custom",
    authMode: "required",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com"
  },
  ollama: {
    id: "",
    name: "Ollama",
    origin: "custom",
    authMode: "none",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1"
  }
};

const emptyProvider: ProviderConfig = {
  id: "",
  name: "",
  origin: "custom",
  authMode: "required",
  type: "openai-compatible",
  baseUrl: "",
  enabled: true,
  models: [],
  keyValue: "",
  hasKey: false,
  isBuiltIn: false,
  canDelete: true,
  isRuntimeCallable: false,
  runtimeErrors: []
};

export function ProvidersManager(): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [waifus, setWaifus] = useState<WaifuEditorPayload[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<ProviderConfig>(emptyProvider);
  const [testResult, setTestResult] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    void load();
  }, []);

  const load = async (preferredId?: string) => {
    setLoading(true);
    try {
      const [providerResponse, waifuResponse] = await Promise.all([
        api.getProviders(),
        api.getWaifus()
      ]);
      setProviders(providerResponse.providers);
      setWaifus(waifuResponse.waifus);
      const nextSelectedProvider =
        providerResponse.providers.find((provider) => provider.id === preferredId) ??
        providerResponse.providers.find((provider) => provider.id === selectedId) ??
        providerResponse.providers[0];
      if (nextSelectedProvider) {
        setSelectedId(nextSelectedProvider.id);
        setDraft(nextSelectedProvider);
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading && providers.length === 0) {
    return <Panel className="h-[420px] animate-pulse" />;
  }

  const save = async () => {
    if (providers.some((provider) => provider.id === draft.id)) {
      await api.updateProvider(draft.id, draft);
      toast("Provider saved.");
    } else {
      await api.createProvider(draft);
      toast("Provider created.");
    }
    await load(draft.id);
  };

  return (
    <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Panel className="flex min-h-0 flex-col p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Providers</p>
            <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">AI Routes</h3>
          </div>
          <Button
            tone="ghost"
            onClick={() => {
              setSelectedId("");
              setDraft(emptyProvider);
            }}
          >
            New
          </Button>
        </div>

        <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {providers.map((provider) => (
            <button
              key={provider.id}
              className={`w-full rounded-2xl border px-4 py-3 text-left ${
                selectedId === provider.id
                  ? "border-accent/40 bg-accent/[0.08]"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
              onClick={() => {
                setSelectedId(provider.id);
                setDraft(provider);
                setTestResult("");
              }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{provider.name}</p>
                  <p className="text-sm text-ink-muted">{provider.baseUrl}</p>
                </div>
                <div className="flex gap-2">
                  <Badge>{provider.isBuiltIn ? "Built-in" : "Custom"}</Badge>
                  <Badge>{provider.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
              </div>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Editor</p>
            <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">{draft.name || "New Provider"}</h3>
          </div>
          <div className="flex gap-3">
            <Button
              tone="ghost"
              onClick={async () => {
                if (!selectedId || !draft.canDelete) return;
                if (!window.confirm("Delete this provider?")) return;
                await api.deleteProvider(selectedId);
                toast("Provider deleted.");
                await load();
              }}
              disabled={!selectedId || !draft.canDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button onClick={() => void save()}>
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          {Object.entries(providerTemplates).map(([key, template]) => (
            <Button
              key={key}
              tone="ghost"
              onClick={() => {
                setSelectedId("");
                setDraft({ ...emptyProvider, ...template, models: [] } as ProviderConfig);
                setTestResult("");
              }}
            >
              <PlugZap className="mr-2 h-4 w-4" />
              Add {template.name}
            </Button>
          ))}
        </div>

        <div className="mt-8 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-6 lg:grid-cols-2">
            <Field label="Provider Enabled">
              <Button
                tone={draft.enabled ? "primary" : "ghost"}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                className="w-full justify-start"
              >
                {draft.enabled ? <Check className="mr-2 h-4 w-4" /> : <X className="mr-2 h-4 w-4" />}
                {draft.enabled ? "Enabled" : "Disabled"}
              </Button>
            </Field>
            <Field label="ID">
              <Input
                value={draft.id}
                disabled={Boolean(selectedId)}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </Field>
            <Field label="Name">
              <Input
                value={draft.name}
                disabled={draft.isBuiltIn}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="Type">
              <Select
                value={draft.type}
                disabled={draft.isBuiltIn}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    type: event.target.value as ProviderConfig["type"]
                  })
                }
              >
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </Field>
            <Field label="Auth Mode">
              <Select
                value={draft.authMode}
                disabled={draft.isBuiltIn}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    authMode: event.target.value as ProviderConfig["authMode"]
                  })
                }
              >
                <option value="required">API key required</option>
                <option value="none">No API key</option>
              </Select>
            </Field>
            <Field label="Base URL">
              <Input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </Field>
            <Field className="lg:col-span-2" label="API Key">
              <Input
                type="password"
                value={draft.keyValue}
                onChange={(event) => setDraft({ ...draft, keyValue: event.target.value })}
              />
            </Field>
            <Field className="lg:col-span-2" label="Models">
              <Textarea
                value={draft.models.join(", ")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    models: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean)
                  })
                }
              />
            </Field>
          </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Badge>{draft.origin === "built-in" ? "Built-in seed" : "Custom provider"}</Badge>
          <Badge className={draft.hasKey ? "border-ok/25 bg-ok/[0.08] text-[rgb(110,231,183)]" : undefined}>
            {draft.authMode === "none" ? "Key not required" : draft.hasKey ? "Key configured" : "Key missing"}
          </Badge>
          <Badge className={draft.isRuntimeCallable ? "border-ok/25 bg-ok/[0.08] text-[rgb(110,231,183)]" : "border-warn/25 bg-warn/[0.08] text-[rgb(252,211,77)]"}>
            {draft.isRuntimeCallable ? "Runtime callable" : "Needs configuration"}
          </Badge>
          {draft.runtimeErrors.map((error) => (
            <Badge key={error} className="border-warn/25 bg-warn/[0.08] text-[rgb(252,211,77)]">
              {error}
            </Badge>
          ))}
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Panel className="border-white/10 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Provider Test</p>
                <p className="mt-1 text-sm text-ink-muted">Runs a one-sentence hello prompt.</p>
              </div>
              <Button
                tone="ghost"
                onClick={async () => {
                  try {
                    const result = await api.testProvider(draft.id);
                    setTestResult(result.content ?? result.error ?? "Provider test completed.");
                    toast(result.ok ? "Provider test completed." : "Provider test failed.");
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    setTestResult(message);
                    toast("Provider test failed.");
                  }
                }}
              >
                <Network className="mr-2 h-4 w-4" />
                Test
              </Button>
            </div>
            <p className="mt-3 text-sm text-ink-muted">{testResult || "No test run yet."}</p>
          </Panel>

          <Panel className="border-white/10 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Models</p>
                <p className="mt-1 text-sm text-ink-muted">Query dynamic model lists for local runtimes.</p>
              </div>
              <Button
                tone="ghost"
                onClick={async () => {
                  const result = await api.fetchProviderModels(draft.id);
                  setDraft({ ...draft, models: result.models });
                  setTestResult(
                    result.runtimeErrors?.length
                      ? result.runtimeErrors.join("; ")
                      : result.discoveryAttempted
                        ? "Model discovery completed."
                        : "Showing configured models only."
                  );
                  toast("Model list refreshed.");
                }}
              >
                Refresh
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {draft.models.map((model) => (
                <Badge key={model}>{model}</Badge>
              ))}
            </div>
          </Panel>
        </div>

        <div className="mt-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Used By</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {waifus.filter((waifu) => waifu.waifu.ai.providerId === draft.id).map((waifu) => (
              <Badge key={waifu.waifu.id}>{waifu.waifu.displayName}</Badge>
            ))}
          </div>
        </div>
        </div>
      </Panel>
    </div>
  );
}

function Field({
  label,
  children,
  className
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
