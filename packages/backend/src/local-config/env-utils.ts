export interface EnvReference {
  raw: string;
  variableName: string;
}

export function parseEnvReference(value: string): EnvReference | null {
  const envPrefixMatch = value.match(/^env:([A-Z0-9_]+)$/i);
  if (envPrefixMatch) {
    return {
      raw: value,
      variableName: envPrefixMatch[1]
    };
  }

  const templateMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (templateMatch) {
    return {
      raw: value,
      variableName: templateMatch[1]
    };
  }

  return null;
}

export function resolveEnvString(value: string): string {
  const reference = parseEnvReference(value);
  if (!reference) {
    return value;
  }

  return process.env[reference.variableName] ?? value;
}

export function isUnresolvedEnvString(value: string): boolean {
  const reference = parseEnvReference(value);
  if (!reference) {
    return false;
  }

  return !process.env[reference.variableName];
}

export function hasResolvedNonEmptyValue(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const resolved = resolveEnvString(value).trim();
  if (!resolved) {
    return false;
  }

  return !isUnresolvedEnvString(value);
}

export function isUnsetModelValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "configure-me") {
    return true;
  }

  return isUnresolvedEnvString(value);
}
