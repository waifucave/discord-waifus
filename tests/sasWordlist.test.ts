import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAS_WORDLIST_V1_SHA256,
  SAS_WORDS_V1,
  mapSasIndicesToWordsV1
} from "../src/shared/sasWordlist.js";
import { createRemotePairingV1Fixture } from "../src/shared/remotePairingContract.js";
import { createRemoteAccessJsonSchema } from "../src/shared/schemas/remoteAccessContract.js";

const SOURCE_SHA256 = "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69";
const SAS_SHA256 = "75282c58b95c5c9b54f8b570a74bf85e1ffd78bd7d44973a82c7aebadb813874";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function lines(value: string): string[] {
  expect(value.endsWith("\n")).toBe(true);
  expect(value).not.toContain("\r");
  return value.slice(0, -1).split("\n");
}

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

describe("SAS V1 wordlist artifact", () => {
  const wordlistRoot = path.join(process.cwd(), "contracts", "wordlists");

  it("pins exact upstream and derived bytes", async () => {
    const source = await readFile(
      path.join(wordlistRoot, "source", "eff-short-wordlist-1.txt")
    );
    const sas = await readFile(path.join(wordlistRoot, "sas-v1.txt"));
    expect(sha256(source)).toBe(SOURCE_SHA256);
    expect(sha256(sas)).toBe(SAS_SHA256);
    expect(SAS_WORDLIST_V1_SHA256).toBe(SAS_SHA256);

    const sasWords = lines(sas.toString("ascii"));
    expect(sasWords).toHaveLength(1_024);
    expect(new Set(sasWords).size).toBe(1_024);
    expect(sasWords).toEqual([...SAS_WORDS_V1]);
    expect(sasWords.every((word) => /^[a-z]{4,5}$/u.test(word))).toBe(true);
    expect(new Set(sasWords.map((word) => word.slice(0, 4))).size).toBe(1_024);
  });

  it("accounts for every upstream entry with reviewed exclusion reasons", async () => {
    const sourceLines = lines(await readFile(
      path.join(wordlistRoot, "source", "eff-short-wordlist-1.txt"),
      "ascii"
    ));
    expect(sourceLines).toHaveLength(1_296);
    const sourceWords = sourceLines.map((line, index) => {
      const match = /^(\d{4})\t([^\t]+)$/u.exec(line);
      expect(match, `source line ${index + 1}`).not.toBeNull();
      return match![2];
    });
    expect(new Set(sourceWords).size).toBe(1_296);

    const denylistLines = lines(await readFile(
      path.join(wordlistRoot, "sas-v1-denylist.tsv"),
      "ascii"
    ));
    const exclusions = denylistLines.filter((line) => !line.startsWith("#")).map((line) => {
      const [word, reason, extra] = line.split("\t");
      expect(extra).toBeUndefined();
      expect([
        "too_short",
        "non_lowercase_ascii_letters",
        "shared_first_four",
        "manual_safety_or_clarity",
        "inflected_or_plural"
      ]).toContain(reason);
      return { word, reason };
    });
    expect(exclusions).toHaveLength(272);
    expect(new Set(exclusions.map(({ word }) => word)).size).toBe(272);
    expect(exclusions.reduce<Record<string, number>>((counts, { reason }) => {
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {})).toEqual({
      too_short: 82,
      non_lowercase_ascii_letters: 1,
      shared_first_four: 77,
      manual_safety_or_clarity: 89,
      inflected_or_plural: 23
    });

    const selected = new Set<string>(SAS_WORDS_V1);
    const excluded = new Set(exclusions.map(({ word }) => word));
    expect(sourceWords.filter((word) => selected.has(word))).toEqual([...SAS_WORDS_V1]);
    expect(sourceWords.every((word) => selected.has(word) !== excluded.has(word))).toBe(true);
  });

  it("maps all five 10-bit groups in order and rejects invalid indices", () => {
    expect(mapSasIndicesToWordsV1([1, 23, 456, 789, 1_023])).toEqual([
      "acorn",
      "angel",
      "jeep",
      "slip",
      "zoom"
    ]);
    expect(() => mapSasIndicesToWordsV1([0, 1, 2, 3, 1_024])).toThrow(
      "outside 0-1023"
    );

    const fixture = record(createRemotePairingV1Fixture());
    const expectedWords = [
      ["froth", "rally", "flap", "scan", "storm"],
      ["next", "petty", "trade", "gown", "clump"]
    ];
    for (const [index, handshake] of (fixture.handshakes as unknown[]).entries()) {
      expect(record(record(handshake).derived).sasWords).toEqual(expectedWords[index]);
    }
  });

  it("publishes the immutable mapping hash and reviewed protocol rule", async () => {
    const schema = createRemoteAccessJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.SasWords).toMatchObject({
      "x-waifus-wordlist": "contracts/wordlists/sas-v1.txt",
      "x-waifus-wordlist-sha256": SAS_SHA256,
      "x-waifus-index-width-bits": 10,
      "x-waifus-index-order": "most-significant 10-bit group first"
    });

    const readme = await readFile(path.join(wordlistRoot, "README.md"), "utf8");
    expect(readme).toContain(SOURCE_SHA256);
    expect(readme).toContain(SAS_SHA256);
    expect(readme).toContain("Creative Commons Attribution 4.0 International");
    expect(readme).toContain("pairing-protocol major version");
  });
});
