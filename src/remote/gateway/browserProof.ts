import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import { SavedBrowserSessionsSchema, type SavedBrowserSessions } from "./browserPersistence.js";

export const BrowserPublicKeySchema = SavedBrowserSessionsSchema.shape.browserKeys.element.shape.publicKey;
export function browserKeyId(publicKey: z.infer<typeof BrowserPublicKeySchema>): string {
  const canonical = { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y };
  const key = createPublicKey({ key: canonical, format: "jwk" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error("Unsupported browser key.");
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export class BrowserProofStore {
  private state: SavedBrowserSessions = { version: 1, browserKeys: [] };
  private challenges = new Map<string, { keyId: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  restore(state: SavedBrowserSessions) {
    const saved = SavedBrowserSessionsSchema.parse(state);
    for (const key of saved.browserKeys) if (browserKeyId(key.publicKey) !== key.keyId) throw Error("Untrusted browser key.");
    this.state = saved;
  }
  snapshot(): SavedBrowserSessions { return structuredClone(this.state); }
  register(publicKey: z.infer<typeof BrowserPublicKeySchema>): string {
    const keyId = browserKeyId(publicKey);
    if (!this.state.browserKeys.some(k => k.keyId === keyId)) {
      if (this.state.browserKeys.length >= 1024) throw Error("Browser key capacity reached.");
      this.state.browserKeys.push({ keyId, publicKey });
    }
    return keyId;
  }
  challenge(keyId: string): string | undefined {
    // Concurrent tabs may share a browser key. Do not invalidate another tab's fresh challenge.
    for (const [nonce, value] of this.challenges) if (value.expires <= this.now()) this.challenges.delete(nonce);
    if (!this.state.browserKeys.some(k => k.keyId === keyId) || this.challenges.size >= 32) return undefined;
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(challenge, { keyId, expires: this.now() + 30_000 });
    return challenge;
  }
  consume(value: unknown): boolean {
    const input = z.object({ keyId: z.string().regex(/^[a-f0-9]{64}$/),
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().safeParse(value);
    if (!input.success) return false;
    const { challenge, signature, keyId } = input.data;
    const issued = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    const saved = this.state.browserKeys.find(k => k.keyId === keyId);
    if (!issued || !saved || issued.keyId !== keyId || issued.expires <= this.now()) return false;
    return verify("sha256", Buffer.from(challenge), { key: createPublicKey({ key: saved.publicKey, format: "jwk" }),
      dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  }
  clear(): void { this.state = { version: 1, browserKeys: [] }; this.challenges.clear(); }
}
