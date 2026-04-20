"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "@/lib/api";
import type { OrchestratorConfig, ProviderConfig } from "@/lib/types";
import { Button, Input, Label, Panel, Select } from "./ui";
import { useToast } from "./toast-provider";

export function OrchestratorManager(): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [orchestrator, setOrchestrator] = useState<OrchestratorConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    const [nextProviders, nextOrchestrator] = await Promise.all([
      api.getProviders(),
      api.getOrchestrator()
    ]);
    setProviders(nextProviders.providers);
    setOrchestrator(nextOrchestrator.orchestrator);
  };

  const selectedProvider = providers.find(
    (provider) => provider.id === orchestrator?.providerId
  );

  if (!orchestrator) {
    return <Panel className="h-[520px] animate-pulse" />;
  }

  return (
    <Panel className="flex h-full min-h-0 flex-col p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Brain</p>
          <h3 className="mt-2 font-display text-2xl">Orchestrator Settings</h3>
          <p className="mt-2 text-sm text-slate-400">
            Choose the provider and model that decide who speaks next.
          </p>
        </div>
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.updateOrchestrator(orchestrator);
              toast("Orchestrator settings saved.");
              await refresh();
            } finally {
              setSaving(false);
            }
          }}
        >
          <Save className="mr-2 h-4 w-4" />
          Save Orchestrator
        </Button>
      </div>

      <div className="mt-8 min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="grid gap-6 lg:grid-cols-2">
          <Field label="Provider">
            <Select
              value={orchestrator.providerId}
              onChange={(event) =>
                setOrchestrator({
                  ...orchestrator,
                  providerId: event.target.value,
                  model:
                    providers.find((provider) => provider.id === event.target.value)?.models[0] ?? ""
                })
              }
            >
              <option value="">Select provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Model">
            <Select
              value={orchestrator.model}
              onChange={(event) =>
                setOrchestrator({
                  ...orchestrator,
                  model: event.target.value
                })
              }
            >
              <option value="">Select model</option>
              {(selectedProvider?.models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={`Temperature (${orchestrator.temperature.toFixed(2)})`}>
            <Input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={orchestrator.temperature}
              onChange={(event) =>
                setOrchestrator({
                  ...orchestrator,
                  temperature: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`Max Tokens (${orchestrator.maxTokens})`}>
            <Input
              type="range"
              min="100"
              max="1600"
              step="10"
              value={orchestrator.maxTokens}
              onChange={(event) =>
                setOrchestrator({
                  ...orchestrator,
                  maxTokens: Number(event.target.value)
                })
              }
            />
          </Field>
        </div>
      </div>
    </Panel>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
