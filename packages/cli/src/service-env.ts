export type ManagedService = "backend" | "dashboard";

export function getServiceEnv(service: ManagedService): Record<string, string> {
  if (service === "backend") {
    return {
      NODE_ENV: "production"
    };
  }

  return {
    NODE_ENV: "production",
    PORT: "3000"
  };
}
