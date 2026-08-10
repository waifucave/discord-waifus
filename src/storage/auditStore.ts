import { z } from "zod";
import { redactSecrets } from "../backend/redaction.js";
import { resolveDataPath } from "../config/paths.js";
import {
  ADMIN_AUDIT_RETENTION_SECONDS,
  AdministrativeAuditRecordV1Schema,
  MAX_ADMIN_AUDIT_RECORD_BYTES,
  MAX_ADMIN_AUDIT_RECORDS,
  MAX_ADMIN_AUDIT_STORE_BYTES,
  type AdministrativeAuditRecordV1
} from "../shared/schemas/adminOperations.js";
import { atomicWriteJson } from "./atomic.js";
import { StorageService } from "./storageService.js";

const AUDIT_STORE_PATH = "app/remote-access/audit/ledger.json";
const AUDIT_LOCK = "remote-access:audit";

const AuditLedgerSchema = z.object({
  version: z.literal(1),
  records: z.array(AdministrativeAuditRecordV1Schema)
}).strict();

type AuditLedger = z.infer<typeof AuditLedgerSchema>;

export class AuditContentForbiddenError extends Error {
  constructor() {
    super("Administrative audit metadata contains forbidden secret material.");
    this.name = "AuditContentForbiddenError";
  }
}

export class AuditStoreCapacityError extends Error {
  constructor(message = "Administrative audit capacity is exhausted.") {
    super(message);
    this.name = "AuditStoreCapacityError";
  }
}

export type AuditStoreOptions = {
  storage?: StorageService;
  now?: () => bigint;
  retentionSeconds?: bigint;
  maxRecords?: number;
  maxStoreBytes?: number;
  maxRecordBytes?: number;
};

export class AuditStore {
  readonly filePath: string;
  private readonly storage: StorageService;
  private readonly now: () => bigint;
  private readonly retentionSeconds: bigint;
  private readonly maxRecords: number;
  private readonly maxStoreBytes: number;
  private readonly maxRecordBytes: number;

  constructor(readonly dataRoot: string, options: AuditStoreOptions = {}) {
    this.storage = options.storage ?? new StorageService(dataRoot);
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.retentionSeconds = options.retentionSeconds ?? ADMIN_AUDIT_RETENTION_SECONDS;
    this.maxRecords = options.maxRecords ?? MAX_ADMIN_AUDIT_RECORDS;
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_ADMIN_AUDIT_STORE_BYTES;
    this.maxRecordBytes = options.maxRecordBytes ?? MAX_ADMIN_AUDIT_RECORD_BYTES;
    this.filePath = resolveDataPath(dataRoot, AUDIT_STORE_PATH);
  }

  async append(input: AdministrativeAuditRecordV1): Promise<AdministrativeAuditRecordV1> {
    const record = AdministrativeAuditRecordV1Schema.parse(input);
    this.assertNoForbiddenContent(record);
    if (recordBytes(record) > this.maxRecordBytes) {
      throw new AuditStoreCapacityError("Administrative audit record exceeds its byte limit.");
    }
    return this.storage.locks.withLock(AUDIT_LOCK, async () => {
      const retained = this.retain(await this.readLedger(), this.now());
      const records = [...retained.records, record].sort(compareAuditRecords);
      while (
        records.length > 1
        && (records.length > this.maxRecords || ledgerBytes({ version: 1, records }) > this.maxStoreBytes)
      ) {
        const oldestOtherRecord = records.findIndex((candidate) => candidate !== record);
        if (oldestOtherRecord === -1) break;
        records.splice(oldestOtherRecord, 1);
      }
      const next = AuditLedgerSchema.parse({ version: 1, records });
      if (next.records.length > this.maxRecords || ledgerBytes(next) > this.maxStoreBytes) {
        throw new AuditStoreCapacityError();
      }
      await atomicWriteJson(this.filePath, next, { mode: 0o600 });
      return record;
    });
  }

  async list(): Promise<AdministrativeAuditRecordV1[]> {
    return this.storage.locks.withLock(AUDIT_LOCK, async () => {
      const ledger = await this.readLedger();
      const retained = this.retain(ledger, this.now());
      if (retained.records.length !== ledger.records.length) {
        await atomicWriteJson(this.filePath, retained, { mode: 0o600 });
      }
      return retained.records.map((record) => structuredClone(record));
    });
  }

  private async readLedger(): Promise<AuditLedger> {
    return this.storage.readJson(
      AUDIT_STORE_PATH,
      AuditLedgerSchema,
      { version: 1, records: [] }
    );
  }

  private retain(ledger: AuditLedger, now: bigint): AuditLedger {
    const records = ledger.records
      .filter((record) => BigInt(record.timestamp) + this.retentionSeconds > now)
      .sort(compareAuditRecords);
    return AuditLedgerSchema.parse({ version: 1, records });
  }

  private assertNoForbiddenContent(record: AdministrativeAuditRecordV1): void {
    const textualMetadata = {
      actor: record.actor,
      delegation: record.delegation,
      action: record.action,
      resource: record.resource
    };
    if (JSON.stringify(redactSecrets(textualMetadata)) !== JSON.stringify(textualMetadata)) {
      throw new AuditContentForbiddenError();
    }
  }
}

function compareAuditRecords(
  left: AdministrativeAuditRecordV1,
  right: AdministrativeAuditRecordV1
): number {
  const time = BigInt(left.timestamp) - BigInt(right.timestamp);
  if (time < 0n) return -1;
  if (time > 0n) return 1;
  return 0;
}

function recordBytes(record: AdministrativeAuditRecordV1): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function ledgerBytes(ledger: AuditLedger): number {
  return Buffer.byteLength(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}
