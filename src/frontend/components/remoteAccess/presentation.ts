import type { HelperTarget, RemoteAccessDiagnostics } from "../../api/types";

export function formatHelperTarget(target: HelperTarget | null): string {
  if (!target) return "Unavailable";
  const architecture = target.arch === "arm" ? `armv${target.goarm}` : target.arch;
  const os = target.os === "darwin" ? "macOS" : target.os === "win32" ? "Windows" : "Linux";
  return `${os} ${architecture}`;
}

export function formatUnixSeconds(value: string | null): string {
  if (value === null) return "Never";
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return "Unknown";
  return new Date(milliseconds).toLocaleString();
}

export function stateTone(state: string): "mint" | "butter" | "peach" {
  return state === "ready" || state === "active" || state === "connected" || state === "direct"
    ? "mint"
    : state === "starting" || state === "connecting" || state === "reconnecting" || state === "renewal_due"
      ? "butter"
      : "peach";
}

export function prohibitedTrafficIsZero(diagnostics: RemoteAccessDiagnostics): boolean {
  return Object.values(diagnostics.prohibited).every((value) => value === "0");
}
