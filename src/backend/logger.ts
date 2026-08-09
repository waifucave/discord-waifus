import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appDataPath } from "../config/paths.js";
import { redactSecrets } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  time: string;
  level: LogLevel;
  message: string;
  context?: unknown;
};

export type Logger = {
  debug: (message: string, context?: unknown) => void;
  info: (message: string, context?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
  error: (message: string, context?: unknown) => void;
  recent?: () => LogEntry[];
  subscribe?: (listener: (entry: LogEntry) => void) => () => void;
};

export function createLogger(options: {
  dataRoot?: string;
  level?: LogLevel;
  console?: Pick<Console, "log" | "error">;
} = {}): Logger {
  const minLevel = levelWeight(options.level ?? "info");
  const output = options.console ?? console;
  const logFile = options.dataRoot ? appDataPath(options.dataRoot, "logs", "backend.log") : undefined;
  const listeners = new Set<(entry: LogEntry) => void>();
  const recentEntries: LogEntry[] = [];

  function emit(level: LogLevel, message: string, context?: unknown): void {
    if (levelWeight(level) < minLevel) {
      return;
    }
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      message: redactSecrets(message),
      context: context === undefined ? undefined : redactSecrets(context)
    };
    recentEntries.unshift(entry);
    if (recentEntries.length > 200) {
      recentEntries.pop();
    }
    for (const listener of listeners) {
      listener(entry);
    }
    const line = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      output.error(line);
    } else {
      output.log(line);
    }
    if (logFile) {
      void mkdir(path.dirname(logFile), { recursive: true })
        .then(() => appendFile(logFile, line + "\n", { mode: 0o600 }))
        .catch(() => undefined);
    }
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    recent: () => [...recentEntries],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function levelWeight(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
  }
}
