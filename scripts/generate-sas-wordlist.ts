import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt";
const SOURCE_SHA256 = "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69";
const SOURCE_ENTRY_COUNT = 1_296;
const SAS_ENTRY_COUNT = 1_024;

const SHARED_FIRST_FOUR_EXCLUSIONS = words(`
  anger ashen baked boney booth brink brook chain cheek chest chill civil clash clasp clear cleat
  clink crank crept crowd crush curvy decal decay decor fifth fling given graph grasp grave greet
  juicy lever lived mousy panty plank quill quota react relay scare scary scoot scorn shady share
  sheet shelf shiny shown skies sleek sleet slick snarl snort spent spoof spool squat stank stark
  stool stoop stray stung swear tasty thing thump trace trait truce twins wages
`);

const MANUAL_SAFETY_AND_CLARITY_EXCLUSIONS = words(`
  agony alarm arson bash blast bully bust chaos chase chump crazy crook cult curse deaf debt dizzy
  drown ebay enter error evil exit false fetal filth flirt fool frail gore grief grope grunt harm
  hate hurt islam junky kung lying mardi moan moist morse pagan panic pest petri polio pork prude
  punk rabid rage rash rebel reset riot rogue ruin sadly saint santa scam sect silly slain slang
  slash slob slum snuff spew spoil start stop sweat theft thong trash trump viral virus vixen womb
  wrath wreck xerox yahoo
`);

const INFLECTED_OR_PLURAL_EXCLUSIONS = words(`
  acts aids ashes bats boots eats elves gains gills herbs jaws limes pants props stays suds taps
  aged aging armed cried dried eaten
`);

type ExclusionReason =
  | "too_short"
  | "non_lowercase_ascii_letters"
  | "shared_first_four"
  | "manual_safety_or_clarity"
  | "inflected_or_plural";

interface SourceEntry {
  code: string;
  word: string;
}

interface GeneratedWordlistFiles {
  sourceBytes: Buffer;
  sasBytes: Buffer;
  denylistBytes: Buffer;
  typescriptBytes: Buffer;
  goBytes: Buffer;
  sasSha256: string;
  selectedWords: readonly string[];
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const wordlistRoot = path.join(repositoryRoot, "contracts", "wordlists");
const checkedSourcePath = path.join(wordlistRoot, "source", "eff-short-wordlist-1.txt");
const sasPath = path.join(wordlistRoot, "sas-v1.txt");
const denylistPath = path.join(wordlistRoot, "sas-v1-denylist.tsv");
const typescriptPath = path.join(repositoryRoot, "src", "shared", "sasWordlist.ts");
const goPath = path.join(
  repositoryRoot,
  "contracts",
  "remote",
  "v1",
  "conformance-go",
  "internal",
  "pairing",
  "sas_wordlist_generated.go"
);

function words(value: string): readonly string[] {
  return value.trim().split(/\s+/u);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedDiceCodes(): string[] {
  const result: string[] = [];
  for (let first = 1; first <= 6; first += 1) {
    for (let second = 1; second <= 6; second += 1) {
      for (let third = 1; third <= 6; third += 1) {
        for (let fourth = 1; fourth <= 6; fourth += 1) {
          result.push(`${first}${second}${third}${fourth}`);
        }
      }
    }
  }
  return result;
}

function parseSource(sourceBytes: Buffer): SourceEntry[] {
  if (sha256(sourceBytes) !== SOURCE_SHA256) {
    throw new Error(`EFF source SHA-256 does not match ${SOURCE_SHA256}.`);
  }
  const source = sourceBytes.toString("ascii");
  if (!source.endsWith("\n") || source.includes("\r")) {
    throw new Error("EFF source must be LF-terminated ASCII without CR bytes.");
  }
  const lines = source.slice(0, -1).split("\n");
  if (lines.length !== SOURCE_ENTRY_COUNT) {
    throw new Error(`EFF source has ${lines.length} entries; expected ${SOURCE_ENTRY_COUNT}.`);
  }
  const codes = expectedDiceCodes();
  const seenWords = new Set<string>();
  return lines.map((line, index) => {
    const match = /^(\d{4})\t([^\t]+)$/u.exec(line);
    if (!match) {
      throw new Error(`Malformed EFF source line ${index + 1}.`);
    }
    const [, code, word] = match;
    if (code !== codes[index]) {
      throw new Error(`Unexpected dice code ${code} on EFF source line ${index + 1}.`);
    }
    if (!/^[a-z-]{3,5}$/u.test(word)) {
      throw new Error(`Unexpected EFF source word ${JSON.stringify(word)}.`);
    }
    if (seenWords.has(word)) {
      throw new Error(`Duplicate EFF source word ${word}.`);
    }
    seenWords.add(word);
    return { code, word };
  });
}

function addExplicitExclusions(
  exclusions: Map<string, ExclusionReason>,
  sourceWords: ReadonlySet<string>,
  candidates: readonly string[],
  reason: ExclusionReason
): void {
  for (const word of candidates) {
    if (!sourceWords.has(word)) {
      throw new Error(`Reviewed exclusion ${word} is absent from the EFF source.`);
    }
    if (exclusions.has(word)) {
      throw new Error(`Reviewed exclusion ${word} appears in multiple categories.`);
    }
    exclusions.set(word, reason);
  }
}

function buildExclusions(entries: readonly SourceEntry[]): Map<string, ExclusionReason> {
  const sourceWords = new Set(entries.map((entry) => entry.word));
  const exclusions = new Map<string, ExclusionReason>();
  for (const { word } of entries) {
    if (word.length < 4) {
      exclusions.set(word, "too_short");
    } else if (!/^[a-z]+$/u.test(word)) {
      exclusions.set(word, "non_lowercase_ascii_letters");
    }
  }
  addExplicitExclusions(
    exclusions,
    sourceWords,
    SHARED_FIRST_FOUR_EXCLUSIONS,
    "shared_first_four"
  );
  addExplicitExclusions(
    exclusions,
    sourceWords,
    MANUAL_SAFETY_AND_CLARITY_EXCLUSIONS,
    "manual_safety_or_clarity"
  );
  addExplicitExclusions(
    exclusions,
    sourceWords,
    INFLECTED_OR_PLURAL_EXCLUSIONS,
    "inflected_or_plural"
  );
  const expectedExcluded = SOURCE_ENTRY_COUNT - SAS_ENTRY_COUNT;
  if (exclusions.size !== expectedExcluded) {
    throw new Error(`Reviewed exclusions total ${exclusions.size}; expected ${expectedExcluded}.`);
  }
  return exclusions;
}

function assertSelectedWords(wordsV1: readonly string[]): void {
  if (wordsV1.length !== SAS_ENTRY_COUNT) {
    throw new Error(`SAS V1 contains ${wordsV1.length} words; expected ${SAS_ENTRY_COUNT}.`);
  }
  const seenWords = new Set<string>();
  const seenPrefixes = new Set<string>();
  for (const word of wordsV1) {
    if (!/^[a-z]{4,5}$/u.test(word)) {
      throw new Error(`SAS V1 word ${JSON.stringify(word)} is not 4-5 lowercase ASCII letters.`);
    }
    if (seenWords.has(word)) {
      throw new Error(`Duplicate SAS V1 word ${word}.`);
    }
    const prefix = word.slice(0, 4);
    if (seenPrefixes.has(prefix)) {
      throw new Error(`SAS V1 first-four collision at ${prefix}.`);
    }
    seenWords.add(word);
    seenPrefixes.add(prefix);
  }
}

function generatedTypeScript(wordsV1: readonly string[], wordlistHash: string): string {
  const wordLines = wordsV1.map((word) => `  ${JSON.stringify(word)},`).join("\n");
  return `// Generated by scripts/generate-sas-wordlist.ts. Do not edit directly.\n\n`
    + `export const SAS_WORDLIST_V1_SHA256 = ${JSON.stringify(wordlistHash)};\n\n`
    + `export const SAS_WORDS_V1 = [\n${wordLines}\n] as const;\n\n`
    + `export type SasWordV1 = (typeof SAS_WORDS_V1)[number];\n`
    + `export type SasIndicesV1 = readonly [number, number, number, number, number];\n`
    + `export type SasWordsV1 = readonly [SasWordV1, SasWordV1, SasWordV1, SasWordV1, SasWordV1];\n\n`
    + `export function mapSasIndicesToWordsV1(indices: SasIndicesV1): SasWordsV1 {\n`
    + `  const words = indices.map((index) => {\n`
    + `    if (!Number.isInteger(index) || index < 0 || index >= SAS_WORDS_V1.length) {\n`
    + `      throw new RangeError(\`SAS V1 index \${index} is outside 0-1023.\`);\n`
    + `    }\n`
    + `    return SAS_WORDS_V1[index]!;\n`
    + `  });\n`
    + `  return words as unknown as SasWordsV1;\n`
    + `}\n`;
}

function generatedGo(wordsV1: readonly string[], wordlistHash: string): string {
  const wordLines = wordsV1.map((word) => `\t${JSON.stringify(word)},`).join("\n");
  return `// Code generated by scripts/generate-sas-wordlist.ts. DO NOT EDIT.\n\n`
    + `package pairing\n\n`
    + `import "fmt"\n\n`
    + `const SASWordlistV1SHA256 = ${JSON.stringify(wordlistHash)}\n\n`
    + `var SASWordsV1 = [...]string{\n${wordLines}\n}\n\n`
    + `func MapSASIndicesToWordsV1(indices [5]uint16) ([5]string, error) {\n`
    + `\twords := [5]string{}\n`
    + `\tfor index, value := range indices {\n`
    + `\t\tif int(value) >= len(SASWordsV1) {\n`
    + `\t\t\treturn [5]string{}, fmt.Errorf("SAS V1 index %d is outside 0-1023", value)\n`
    + `\t\t}\n`
    + `\t\twords[index] = SASWordsV1[value]\n`
    + `\t}\n`
    + `\treturn words, nil\n`
    + `}\n`;
}

function generateWordlistFiles(sourceBytes: Buffer): GeneratedWordlistFiles {
  const entries = parseSource(sourceBytes);
  const exclusions = buildExclusions(entries);
  const selectedWords = entries
    .filter((entry) => !exclusions.has(entry.word))
    .map((entry) => entry.word);
  assertSelectedWords(selectedWords);
  const sasBytes = Buffer.from(`${selectedWords.join("\n")}\n`, "ascii");
  const sasSha256 = sha256(sasBytes);
  const denylistLines = entries
    .filter((entry) => exclusions.has(entry.word))
    .map((entry) => `${entry.word}\t${exclusions.get(entry.word)!}`);
  const denylistBytes = Buffer.from(
    `# source: ${SOURCE_URL}\n# source-sha256: ${SOURCE_SHA256}\n`
      + "# word\treason\n"
      + `${denylistLines.join("\n")}\n`,
    "ascii"
  );
  return {
    sourceBytes,
    sasBytes,
    denylistBytes,
    typescriptBytes: Buffer.from(generatedTypeScript(selectedWords, sasSha256), "utf8"),
    goBytes: Buffer.from(generatedGo(selectedWords, sasSha256), "utf8"),
    sasSha256,
    selectedWords
  };
}

async function readSource(argumentPath?: string): Promise<Buffer> {
  return readFile(argumentPath ? path.resolve(argumentPath) : checkedSourcePath);
}

async function writeGeneratedFiles(files: GeneratedWordlistFiles, sourceArgument?: string): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(checkedSourcePath), { recursive: true }),
    mkdir(path.dirname(typescriptPath), { recursive: true }),
    mkdir(path.dirname(goPath), { recursive: true })
  ]);
  if (sourceArgument) {
    await writeFile(checkedSourcePath, files.sourceBytes);
  }
  await Promise.all([
    writeFile(sasPath, files.sasBytes),
    writeFile(denylistPath, files.denylistBytes),
    writeFile(typescriptPath, files.typescriptBytes),
    writeFile(goPath, files.goBytes)
  ]);
}

async function checkGeneratedFiles(files: GeneratedWordlistFiles): Promise<void> {
  const expected = new Map<string, Buffer>([
    [sasPath, files.sasBytes],
    [denylistPath, files.denylistBytes],
    [typescriptPath, files.typescriptBytes],
    [goPath, files.goBytes]
  ]);
  const mismatches: string[] = [];
  for (const [filePath, contents] of expected) {
    let actual: Buffer;
    try {
      actual = await readFile(filePath);
    } catch {
      mismatches.push(path.relative(repositoryRoot, filePath));
      continue;
    }
    if (!actual.equals(contents)) {
      mismatches.push(path.relative(repositoryRoot, filePath));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SAS wordlist files are missing or stale: ${mismatches.join(", ")}. `
        + "Run npm run contracts:remote:generate."
    );
  }
}

function sourceArgument(args: readonly string[]): string | undefined {
  const index = args.indexOf("--source");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--source requires a file path.");
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  const providedSource = sourceArgument(args);
  const files = generateWordlistFiles(await readSource(providedSource));
  if (mode === "--write") {
    await writeGeneratedFiles(files, providedSource);
    process.stdout.write(`generated SAS V1 ${files.sasSha256}\n`);
    return;
  }
  if (mode === "--check") {
    if (providedSource) {
      throw new Error("--source is valid only with --write.");
    }
    await checkGeneratedFiles(files);
    process.stdout.write(`verified SAS V1 ${files.sasSha256}\n`);
    return;
  }
  throw new Error(
    "Usage: generate-sas-wordlist.ts --write [--source <path>] | --check"
  );
}

await main();
