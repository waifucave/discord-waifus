#!/usr/bin/env node
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildOcrEnv, readManifest, validateOcrPackage } from "./validate-ocr-package.mjs";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const packageDir = path.resolve(args.package ?? currentPackageDir());

try {
  await assemblePackage(packageDir, args);
  if (!args.skipValidate) {
    await validateOcrPackage(packageDir, { skipSmoke: args.skipSmoke });
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

async function assemblePackage(packageDir, options) {
  const manifest = await readManifest(packageDir);
  assertHostMatchesManifest(manifest, options);

  const tesseractBin = await findTesseractBinary(options.tesseract);
  const sourceRoot = await findTesseractRoot(tesseractBin);
  const tessdataDir = await findTessdataDir(options.tessdata, sourceRoot, tesseractBin);
  const binaryDest = resolvePackagePath(packageDir, manifest.binary);
  const tessdataDest = resolvePackagePath(packageDir, manifest.tessdata);
  const libDest = resolvePackagePath(packageDir, "lib");
  const licenseDest = resolvePackagePath(packageDir, "licenses");

  await rm(path.dirname(binaryDest), { recursive: true, force: true });
  await rm(libDest, { recursive: true, force: true });
  await rm(tessdataDest, { recursive: true, force: true });
  await rm(licenseDest, { recursive: true, force: true });
  await mkdir(path.dirname(binaryDest), { recursive: true });
  await mkdir(tessdataDest, { recursive: true });
  await mkdir(licenseDest, { recursive: true });

  await copyExecutable(tesseractBin, binaryDest);
  await copyIfPresent(path.join(tessdataDir, "eng.traineddata"), path.join(tessdataDest, "eng.traineddata"), true);
  await copyIfPresent(path.join(tessdataDir, "osd.traineddata"), path.join(tessdataDest, "osd.traineddata"), false);
  await copyLicenseFiles(sourceRoot, path.join(licenseDest, "tesseract"));

  if (manifest.platform === "darwin") {
    await copyDarwinLibraries(packageDir, manifest, binaryDest, licenseDest);
  } else if (manifest.platform === "linux") {
    await copyLinuxLibraries(packageDir, manifest, binaryDest, licenseDest);
  } else if (manifest.platform === "win32") {
    await copyWindowsLibraries(tesseractBin, binaryDest, licenseDest);
  }

  const env = buildOcrEnv(packageDir, manifest);
  const { stdout } = await execFileAsync(binaryDest, ["--version"], { env, timeout: 5_000, maxBuffer: 256 * 1024 });
  console.log(stdout.split(/\r?\n/u)[0]);
}

async function copyDarwinLibraries(packageDir, manifest, binaryDest, licenseDest) {
  const libDest = resolvePackagePath(packageDir, "lib");
  await mkdir(libDest, { recursive: true });
  const copied = new Map();
  const copiedByDependency = new Map();
  const queue = [binaryDest];

  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    const deps = await darwinDependencies(file);
    for (const dep of deps) {
      if (isDarwinSystemLibrary(dep)) continue;
      const source = await resolveDarwinDependencySource(dep, file);
      const basename = path.basename(dep);
      if (!copied.has(basename)) {
        const dest = path.join(libDest, basename);
        await copyExecutable(source, dest);
        copied.set(basename, { source, dest });
        queue.push(dest);
        await copyLicenseFiles(await findFormulaRoot(source), path.join(licenseDest, basename.replace(/\.dylib$/u, ""))).catch(() => undefined);
      }
      copiedByDependency.set(dep, copied.get(basename));
    }
  }

  for (const file of [binaryDest, ...[...copied.values()].map((entry) => entry.dest)]) {
    const deps = await darwinDependencies(file);
    const isLibrary = path.dirname(file) === libDest;
    if (isLibrary) {
      await execFileAsync("install_name_tool", ["-id", `@loader_path/${path.basename(file)}`, file]);
    }
    for (const dep of deps) {
      const entry = copiedByDependency.get(dep);
      if (!entry) continue;
      const basename = path.basename(entry.dest);
      const replacement = isLibrary ? `@loader_path/${basename}` : `@loader_path/../lib/${basename}`;
      await execFileAsync("install_name_tool", ["-change", dep, replacement, file]);
    }
  }

  for (const file of [binaryDest, ...[...copied.values()].map((entry) => entry.dest)]) {
    await execFileAsync("codesign", ["--force", "--sign", "-", file]);
  }

  if (manifest.env?.DYLD_LIBRARY_PATH === undefined) {
    console.warn("darwin OCR manifest does not include DYLD_LIBRARY_PATH; package-local libraries may not resolve.");
  }
}

async function copyLinuxLibraries(packageDir, manifest, binaryDest, licenseDest) {
  const libDest = resolvePackagePath(packageDir, "lib");
  await mkdir(libDest, { recursive: true });
  const copied = new Set();
  const queue = [binaryDest];

  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    const deps = await linuxDependencies(file);
    for (const dep of deps) {
      const basename = path.basename(dep);
      if (isLinuxCoreLibrary(basename) || copied.has(basename)) continue;
      const dest = path.join(libDest, basename);
      await copyExecutable(dep, dest);
      copied.add(basename);
      queue.push(dest);
      await copyLicenseFiles(await findFormulaRoot(dep), path.join(licenseDest, basename.replace(/\.so.*/u, ""))).catch(() => undefined);
    }
  }

  if (manifest.env?.LD_LIBRARY_PATH === undefined) {
    console.warn("linux OCR manifest does not include LD_LIBRARY_PATH; package-local libraries may not resolve.");
  }
}

async function copyWindowsLibraries(tesseractBin, binaryDest, licenseDest) {
  const sourceDir = path.dirname(tesseractBin);
  const destDir = path.dirname(binaryDest);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
      await copyExecutable(path.join(sourceDir, entry.name), path.join(destDir, entry.name));
    }
  }
  await copyLicenseFiles(await findFormulaRoot(tesseractBin), path.join(licenseDest, "tesseract")).catch(() => undefined);
}

async function darwinDependencies(file) {
  const { stdout } = await execFileAsync("otool", ["-L", file], { maxBuffer: 512 * 1024 });
  return stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/u)[0])
    .filter(Boolean);
}

async function darwinRpaths(file) {
  const { stdout } = await execFileAsync("otool", ["-l", file], { maxBuffer: 512 * 1024 });
  const lines = stdout.split(/\r?\n/u);
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes("LC_RPATH")) continue;
    const pathLine = lines.slice(index, index + 6).find((line) => line.trim().startsWith("path "));
    const match = pathLine?.trim().match(/^path\s+(\S+)/u);
    if (match?.[1]) rpaths.push(match[1]);
  }
  return rpaths;
}

async function resolveDarwinDependencySource(dep, referencingFile) {
  const candidates = [];
  if (dep.startsWith("@loader_path/")) {
    candidates.push(path.resolve(path.dirname(referencingFile), dep.slice("@loader_path/".length)));
  } else if (dep.startsWith("@executable_path/")) {
    candidates.push(path.resolve(path.dirname(referencingFile), dep.slice("@executable_path/".length)));
  } else if (dep.startsWith("@rpath/")) {
    const suffix = dep.slice("@rpath/".length);
    for (const rpath of await darwinRpaths(referencingFile)) {
      candidates.push(path.join(resolveDarwinTokenPath(rpath, referencingFile), suffix));
    }
    candidates.push(path.join("/opt/homebrew/lib", suffix), path.join("/usr/local/lib", suffix));
  } else {
    candidates.push(dep);
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return realpath(candidate).catch(() => candidate);
  }
  throw new Error(`Could not resolve macOS library dependency ${dep} referenced by ${referencingFile}.`);
}

function resolveDarwinTokenPath(value, referencingFile) {
  if (value === "@loader_path") {
    return path.dirname(referencingFile);
  }
  if (value.startsWith("@loader_path/")) {
    return path.resolve(path.dirname(referencingFile), value.slice("@loader_path/".length));
  }
  return value;
}

async function linuxDependencies(file) {
  const { stdout } = await execFileAsync("ldd", [file], { maxBuffer: 512 * 1024 });
  return stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const arrow = line.match(/=>\s+(\S+)/u);
      if (arrow?.[1]?.startsWith("/")) return [arrow[1]];
      const direct = line.trim().match(/^(\S+)\s+\(/u);
      return direct?.[1]?.startsWith("/") ? [direct[1]] : [];
    });
}

async function findTesseractBinary(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.TESSERACT_BIN) return path.resolve(process.env.TESSERACT_BIN);
  const command = process.platform === "win32" ? "where" : "which";
  const args = ["tesseract"];
  const { stdout } = await execFileAsync(command, args, { timeout: 2_000, maxBuffer: 64 * 1024 });
  const first = stdout.split(/\r?\n/u).find(Boolean);
  if (!first) throw new Error("Could not locate tesseract on PATH.");
  return first;
}

async function findTessdataDir(explicit, sourceRoot, tesseractBin) {
  const candidates = [
    explicit,
    process.env.TESSDATA_PREFIX,
    path.join(sourceRoot, "share", "tessdata"),
    path.join(path.dirname(tesseractBin), "..", "share", "tessdata"),
    path.join(path.dirname(tesseractBin), "tessdata"),
    "/usr/share/tesseract-ocr/5/tessdata",
    "/usr/share/tesseract-ocr/4.00/tessdata",
    "/usr/share/tessdata",
    "/usr/local/share/tessdata",
    "/opt/homebrew/share/tessdata"
  ].filter(Boolean);

  if (process.platform === "darwin") {
    const brewPrefix = await execFileAsync("brew", ["--prefix", "tesseract"], { timeout: 2_000, maxBuffer: 64 * 1024 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined);
    if (brewPrefix) candidates.push(path.join(brewPrefix, "share", "tessdata"));
  }

  for (const candidate of candidates) {
    const dir = path.resolve(candidate);
    if (await isFile(path.join(dir, "eng.traineddata"))) return dir;
  }
  throw new Error("Could not locate eng.traineddata. Set TESSDATA_PREFIX or pass --tessdata.");
}

async function findTesseractRoot(tesseractBin) {
  const resolved = await realpath(tesseractBin).catch(() => path.resolve(tesseractBin));
  let dir = path.dirname(resolved);
  for (let depth = 0; depth < 5; depth += 1) {
    if (await isFile(path.join(dir, "LICENSE")) || await isFile(path.join(dir, "share", "tessdata", "eng.traineddata"))) {
      return dir;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return path.dirname(resolved);
}

async function findFormulaRoot(filePath) {
  const resolved = await realpath(filePath).catch(() => path.resolve(filePath));
  const parts = resolved.split(path.sep);
  const cellarIndex = parts.lastIndexOf("Cellar");
  if (cellarIndex >= 0 && parts.length > cellarIndex + 2) {
    return parts.slice(0, cellarIndex + 3).join(path.sep) || path.sep;
  }
  let dir = path.dirname(resolved);
  for (let depth = 0; depth < 5; depth += 1) {
    if (await isFile(path.join(dir, "LICENSE")) || await isFile(path.join(dir, "COPYING"))) return dir;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return path.dirname(resolved);
}

async function copyLicenseFiles(sourceRoot, destDir) {
  if (!sourceRoot) return;
  await mkdir(destDir, { recursive: true });
  const names = ["LICENSE", "COPYING", "COPYING.LESSER", "NOTICE", "AUTHORS", "README", "README.md", "ChangeLog"];
  let copied = 0;
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    if (await isFile(source)) {
      await copyFile(source, path.join(destDir, name));
      copied += 1;
    }
  }
  if (copied === 0) {
    await rm(destDir, { recursive: true, force: true });
  }
}

async function copyExecutable(source, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
  if (process.platform !== "win32") {
    await execFileAsync("chmod", ["755", dest]);
  }
}

async function copyIfPresent(source, dest, required) {
  if (!(await isFile(source))) {
    if (required) throw new Error(`Required OCR payload is missing: ${source}`);
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
}

function assertHostMatchesManifest(manifest, options) {
  if (options.force) return;
  if (manifest.platform !== process.platform) {
    throw new Error(`Refusing to assemble ${manifest.platform} package on ${process.platform}; pass --force to override.`);
  }
  if (manifest.arch !== process.arch) {
    throw new Error(`Refusing to assemble ${manifest.arch} package on ${process.arch}; pass --force to override.`);
  }
}

function currentPackageDir() {
  const target = process.platform === "darwin"
    ? `ocr-darwin-${process.arch}`
    : process.platform === "win32"
      ? `ocr-win32-${process.arch}`
      : process.platform === "linux" && process.arch === "x64"
        ? "ocr-linux-x64-gnu"
        : undefined;
  if (!target) throw new Error(`No OCR package target for ${process.platform}/${process.arch}.`);
  return path.join("packages", target);
}

function resolvePackagePath(packageDir, relativePath) {
  return path.join(packageDir, relativePath);
}

function isDarwinSystemLibrary(dep) {
  return dep.startsWith("/usr/lib/") || dep.startsWith("/System/Library/");
}

function isLinuxCoreLibrary(basename) {
  return /^(ld-linux|linux-vdso|libc\.so|libdl\.so|libm\.so|libpthread\.so|librt\.so|libresolv\.so|libgcc_s\.so|libstdc\+\+\.so)/u.test(basename);
}

async function isFile(filePath) {
  return stat(filePath).then((info) => info.isFile(), () => false);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package") {
      result.package = argv[++index];
    } else if (arg === "--tesseract") {
      result.tesseract = argv[++index];
    } else if (arg === "--tessdata") {
      result.tessdata = argv[++index];
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--skip-validate") {
      result.skipValidate = true;
    } else if (arg === "--skip-smoke") {
      result.skipSmoke = true;
    } else if (arg === "--help") {
      console.log("Usage: node scripts/assemble-ocr-package.mjs [--package packages/ocr-darwin-arm64] [--tesseract PATH] [--tessdata DIR]");
      process.exit(0);
    }
  }
  return result;
}
