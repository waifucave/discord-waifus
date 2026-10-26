// Bash isolation (Living cast spec §16.3.5, §16.12, T4, T10) — acceptance-critical. Every command,
// script and Python program runs in just-bash's simulated shell and WebAssembly CPython, in a worker
// thread, over an in-memory copy of her two folders. These tests show that nothing she runs can
// read, write, list or execute anything outside /home/<slug> and /tmp, reach the network or the
// host environment, or block the host: runaway programs are stopped by the limits and the worker
// is terminated while the host's event loop keeps running. No host path appears in any result.
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBash } from "../src/life/bash/runner.js";
import { homeStoreFor, refreshPlacesFile } from "../src/life/home/index.js";
import { selfAuthorIds } from "../src/life/people.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { closeWorlds, herFile, homeOf, lifeWorld, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
let w: LifeWorld;
let ctx: ToolContext;
/** Every command and the result she saw: checked for host paths at the end. */
const seen: Array<{ command: string; text: string }> = [];

/**
 * Her own folders are /home/<slug> and /tmp. A host data root under /tmp (Linux's default temp
 * directory) would share its first segment with her /tmp, so "/tmp/dc-waifus-life-x/pwned.txt"
 * would name a file she may make in her own /tmp rather than a host path. The world is made where
 * no host path can look like one of hers.
 */
function hostBase(): string {
  const tmp = os.tmpdir();
  return /^\/(tmp|home)(\/|$)/u.test(tmp) ? "/var/tmp" : tmp;
}

beforeAll(async () => {
  w = await lifeWorld(roots, { rootBase: hostBase() });
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  ctx = {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps)
  };
  await homeOf(w).write("MEMORY.md", "# Memory\n- [Kevin](people/kevin.md)\n");
  await homeOf(w).write("people/kevin.md", "# Kevin\n");
}, 60_000);

afterAll(async () => {
  // No host path, host user name or host environment value in anything she saw (unless her own
  // command typed it: an error message may repeat the path she asked for).
  // Her own folder names are not host leaks (os.tmpdir() is "/tmp" on Linux).
  const own = new Set(["/", "/tmp", "/home", "/home/ella"]);
  const forbidden = [w.root, process.cwd(), os.homedir(), os.tmpdir(), "node_modules", "dc-waifus-life-", os.userInfo().username].filter((value) => value.length >= 3 && !own.has(value));
  expect(seen.length).toBeGreaterThan(20);
  for (const { command, text } of seen) {
    for (const value of forbidden) if (!command.includes(value)) expect(text, `${command} leaked ${JSON.stringify(value)}`).not.toContain(value);
  }
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
}, 60_000);

let calls = 0;
async function bash(command: string, timeout_ms?: number): Promise<{ text: string; isError: boolean }> {
  calls += 1;
  const output: ToolOutput = await lifeTool("Bash")!.run({ command, ...(timeout_ms ? { timeout_ms } : {}) }, { ...ctx, toolCallId: `call_${calls}` });
  const text = typeof output.content === "string" ? output.content : JSON.stringify(output.content);
  seen.push({ command, text });
  return { text, isError: output.isError === true };
}

let scripts = 0;
/** Saves a Python program in her /tmp (on disk, like a download); returns its path. */
async function saveScript(code: string): Promise<string> {
  scripts += 1;
  const dir = path.join(w.root, "user/waifus/ella/tmp");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `s${scripts}.py`), code);
  return `/tmp/s${scripts}.py`;
}

/** Runs a Python program she saved in /tmp. */
async function py(code: string, timeout_ms?: number): Promise<{ text: string; isError: boolean }> {
  return bash(`python3 ${await saveScript(code)}`, timeout_ms);
}
const exitOf = (text: string) => Number(/\nexit (\d+)/u.exec(`\n${text}`)?.[1] ?? Number.NaN);

describe("the filesystem she sees (§16.2)", { timeout: 60_000 }, () => {
  it("cat /etc/passwd, ls /, cd .. past /home: only her two folders (and the read-only /transcripts) exist", async () => {
    const passwd = await bash("cat /etc/passwd");
    expect(passwd.text).toMatch(/cat: \/etc\/passwd: No such file or directory/u);
    expect(passwd.text).not.toMatch(/root:/u);
    expect(exitOf(passwd.text)).not.toBe(0);
    // /transcripts is read-only and served on demand (§18.3).
    expect((await bash("ls /")).text).toBe("home\ntmp\ntranscripts\nexit 0");
    expect((await bash("ls /home")).text).toBe("ella\nexit 0");
    expect((await bash("pwd; cd ..; cd ..; cd ..; pwd; ls")).text).toBe("/home/ella\n/\nhome\ntmp\ntranscripts\nexit 0");
    for (const command of ["ls /etc", "ls /usr/bin", "ls /bin", "ls /proc", "cat /proc/self/environ", "ls /home/mina", "cat ~/../../etc/hosts"]) {
      const result = await bash(command);
      expect(exitOf(result.text), command).not.toBe(0);
      expect(result.text, command).not.toMatch(/root:|localhost|PATH=|node_modules/u);
    }
    expect((await bash("find / -maxdepth 3 | sort")).text).toBe("/\n/home\n/home/ella\n/home/ella/MEMORY.md\n/home/ella/people\n/tmp\n/transcripts\nexit 0");
    expect((await bash("find / -type f | sort")).text).toBe("/home/ella/MEMORY.md\n/home/ella/people/kevin.md\nexit 0");
  });

  it("absolute host paths are not there, for reading, listing or writing", async () => {
    const host = [w.root, path.join(w.root, "user/waifus/ella/waifu.json"), process.cwd(), os.homedir(), "/Users", "/var", "/private"];
    for (const target of host) {
      const read = await bash(`cat ${JSON.stringify(target)}; ls ${JSON.stringify(target)}`);
      expect(exitOf(read.text), target).not.toBe(0);
      expect(read.text).not.toMatch(/"providerId"|package\.json|\.dc-waifus/u);
    }
    const write = await bash(`echo pwned > ${JSON.stringify(path.join(w.root, "pwned.txt"))}`);
    expect(exitOf(write.text)).not.toBe(0);
    expect(exitOf((await bash("mkdir -p /etc/x")).text)).not.toBe(0);
    expect(exitOf((await bash(`cp ~/MEMORY.md ${JSON.stringify(w.root)}/`)).text)).not.toBe(0);
    await expect(lstat(path.join(w.root, "pwned.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(w.root, "user/waifus/ella"))).not.toContain("etc");
    // A path that only looks like a host temp directory is a path in her own /tmp: the file lands
    // in her tmp folder under the data root, never on the host. (just-bash creates missing parent
    // folders on a redirect, unlike real bash.)
    const name = path.basename(w.root);
    const lookalike = await bash(`echo pwned > /tmp/${name}/pwned.txt`);
    expect(exitOf(lookalike.text)).toBe(0);
    expect(lookalike.text).toContain(`changed: /tmp/${name}/pwned.txt`);
    expect(await herFile(w, "ella", `tmp/${name}/pwned.txt`)).toBe("pwned\n");
    await expect(lstat(path.join(w.root, "pwned.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(exitOf((await bash(`rm -r /tmp/${name}`)).text)).toBe(0);
  });

  it("no links: ln -s and ln fail, Python cannot make one, and nothing is created on disk", async () => {
    for (const command of ["ln -s /etc/passwd ~/l1", "ln -s MEMORY.md l2", "ln MEMORY.md h1"]) {
      const result = await bash(command);
      expect(result.text, command).toMatch(/not permitted|not allowed|not supported/iu);
      expect(exitOf(result.text)).not.toBe(0);
    }
    // CPython-WASM keeps its own in-memory filesystem under her folders: os.symlink there makes a
    // link that lives only in that WebAssembly memory. It never reaches her folders (her files are
    // reached through just-bash's filesystem), following it finds nothing, and it is gone when the
    // command ends. A hard link is not possible at all.
    const script = await saveScript(
      "import os\ntry:\n    os.symlink('/etc/passwd', '/tmp/x')\n    print('symlink made')\nexcept Exception as e:\n    print('symlink', type(e).__name__)\ntry:\n    print(open('/tmp/x').read()[:20])\nexcept Exception as e:\n    print('follow', type(e).__name__)\nprint(sorted(os.listdir('/tmp')))\ntry:\n    os.link('/home/ella/MEMORY.md', '/tmp/h'); print('hardlink')\nexcept Exception as e:\n    print('hardlink', type(e).__name__)\n"
    );
    const viaPython = await bash(`python3 ${script}; ls -a /tmp; cat /tmp/x`);
    expect(viaPython.text).toMatch(/^follow \w+Error$/mu);
    expect(viaPython.text).not.toMatch(/root:/u);
    expect(viaPython.text).not.toMatch(/'x'/u);
    expect(viaPython.text).toMatch(/^hardlink \w+(Error|Exception)$/mu);
    expect(viaPython.text).toMatch(/cat: \/tmp\/x: No such file or directory/u);
    expect(viaPython.text).not.toMatch(/changed:/u);
    for (const name of ["l1", "l2", "h1"]) await expect(lstat(path.join(w.root, "user/waifus/ella/home", name))).rejects.toMatchObject({ code: "ENOENT" });
    const tmp = await readdir(path.join(w.root, "user/waifus/ella/tmp")).catch(() => [] as string[]);
    expect(tmp).not.toContain("x");
    expect(tmp).not.toContain("h");
  });
});

describe("Python (§16.3.5)", { timeout: 120_000 }, () => {
  it("open() of host paths fails; os.listdir sees only her folders; her files are there", async () => {
    const result = await py(
      (
        [
          "import os",
          "print(sorted(os.listdir('/')))",
          "print(sorted(os.listdir('/home')))",
          `for p in ['/etc/passwd', ${JSON.stringify(path.join(w.root, "user/waifus/ella/waifu.json"))}, ${JSON.stringify(os.homedir())}, '/proc/self/environ']:`,
          "    try:",
          "        open(p).read(); print('OPEN', p)",
          "    except Exception as e:",
          "        print('refused', type(e).__name__)",
          "print(open('/home/ella/MEMORY.md').read().splitlines()[0])"
        ].join("\n")
      )
    );
    expect(result.text).toContain("['home', 'tmp', 'transcripts']");
    expect(result.text).toContain("['ella']");
    expect(result.text).not.toContain("OPEN");
    expect(result.text.match(/^refused \w+$/gmu)).toHaveLength(4);
    expect(result.text).toContain("# Memory");
  });

  it("os.system, subprocess, socket, ctypes and import js all fail", async () => {
    const result = await py(
      (
        [
          "import os",
          "def attempt(name, f):",
          "    try:",
          "        r = f(); print(name, 'returned', r)",
          "    except BaseException as e:",
          "        print(name, 'failed', type(e).__name__)",
          "attempt('system', lambda: os.system('ls /'))",
          "import subprocess",
          "attempt('subprocess', lambda: subprocess.run(['ls', '/'], capture_output=True))",
          "attempt('fork', lambda: os.fork())",
          "import socket",
          "attempt('socket', lambda: socket.create_connection(('example.com', 80), timeout=2))",
          "import urllib.request",
          "attempt('urlopen', lambda: urllib.request.urlopen('http://example.com', timeout=2))",
          "attempt('ctypes', lambda: __import__('ctypes'))",
          "attempt('js', lambda: __import__('js'))",
          "attempt('pyodide', lambda: __import__('pyodide'))"
        ].join("\n")
      ),
      30_000
    );
    expect(result.text).toMatch(/^system returned -1$|^system failed \w+$/mu);
    for (const name of ["subprocess", "fork", "socket", "urlopen", "ctypes", "js", "pyodide"]) expect(result.text, name).toMatch(new RegExp(`^${name} failed \\w+$`, "mu"));
  });

  it("the environment shows nothing of the host", async () => {
    const shell = await bash("env | sort");
    const python = await py("import os, json\nprint(json.dumps(dict(os.environ), sort_keys=True))\n");
    for (const result of [shell, python]) {
      expect(result.text).toContain("HOME");
      expect(result.text).toContain("/home/ella");
      for (const [name, value] of Object.entries(process.env)) {
        if (!value || value.length < 6 || ["HOME", "USER", "PWD", "TZ", "PATH", "SHELL", "LANG", "LOGNAME", "OLDPWD", "TERM", "SHLVL", "_"].includes(name)) continue;
        expect(result.text, `host variable ${name}`).not.toContain(value);
      }
      expect(result.text).not.toContain(process.env["PATH"] ?? "\u0000");
    }
  });
});

describe("limits stop runaway programs; the host keeps running (§16.12)", { timeout: 120_000 }, () => {
  it("an infinite loop, a fork-style recursion, a 1 GB string and an output flood are each stopped", async () => {
    const loop = await bash("while true; do :; done", 5_000);
    expect(loop.isError || exitOf(loop.text) !== 0).toBe(true);
    const forkBomb = await bash("f() { f | f & }; f", 5_000);
    expect(forkBomb.isError || exitOf(forkBomb.text) !== 0).toBe(true);
    const big = await py("s = 'x' * 10**9\nprint(len(s))\n", 10_000);
    expect(big.text).not.toMatch(/^1000000000$/mu);
    const width = await bash("printf '%*s' 1000000000 x | wc -c", 5_000);
    expect(width.text).not.toMatch(/^\s*1000000000\s*$/mu);
    const flood = await bash("yes", 3_000);
    expect(flood.isError || exitOf(flood.text) !== 0 || flood.text.includes("(output cut)")).toBe(true);
    expect(flood.text.length).toBeLessThan(20_000);
    const pyFlood = await py("print('y' * 10**8)\n", 3_000);
    expect(pyFlood.text.length).toBeLessThan(20_000);
  });

  it("a Python busy loop is terminated at its timeout; nothing is saved and the event loop stays responsive", async () => {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const started = Date.now();
    const script = await saveScript("while True:\n    pass\n");
    const result = await bash(`echo saved > ~/should-not-exist.md; python3 ${script}`, 2_000);
    histogram.disable();
    expect(result).toEqual({ text: "error: the command took longer than 2 s and was stopped; nothing was saved", isError: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await herFile(w, "ella", "home/should-not-exist.md")).toBeUndefined();
    // The host never ran her program: its event loop kept turning (99th percentile under 50 ms).
    expect(histogram.percentile(99) / 1e6).toBeLessThan(50);
  });

  it("an abort stops the worker at once", async () => {
    const controller = new AbortController();
    const store = homeStoreFor(w.cast.deps, ctx.waifu);
    const running = runBash({ store, command: "while true; do :; done", timeoutMs: 30_000, python: true, timeZone: "UTC", signal: controller.signal, maxFileSystemBytes: 64 * 1024 * 1024 });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const run = await running;
    expect(run.outcome).toBe("aborted");
    expect(run.changes).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("her changes are checked and saved all or nothing (§16.3.5, §16.12)", { timeout: 60_000 }, () => {
  it("files, folders, moves and deletes are saved; places.md can't be removed", async () => {
    const result = await bash("mkdir -p recipes && echo 'flour' > recipes/bread.md && cp people/kevin.md /tmp/k.md && mv /tmp/k.md /tmp/k2.md && echo done");
    expect(result.text).toMatch(/^done\nexit 0\nchanged: [^\n]*~\/recipes\/bread\.md/u);
    expect(await herFile(w, "ella", "home/recipes/bread.md")).toBe("flour\n");
    expect(await herFile(w, "ella", "tmp/k2.md")).toBe("# Kevin\n");
    expect(await herFile(w, "ella", "tmp/k.md")).toBeUndefined();
    const rm = await bash("rm /tmp/k2.md && echo gone");
    expect(rm.text).toContain("deleted: /tmp/k2.md");
    await refreshPlacesFile(w.cast.deps, ctx.waifu);
    for (const command of ["echo x > ~/places.md", "rm ~/places.md", "mv ~/places.md ~/p.md", "sed -i s/a/b/ ~/places.md"]) {
      const places = await bash(command);
      expect(exitOf(places.text), command).not.toBe(0);
      expect(places.text).not.toMatch(/changed: [^\n]*places\.md|deleted: [^\n]*places\.md/u);
    }
    expect(await herFile(w, "ella", "home/places.md")).toContain("# Your places");
  });

  it("a command that breaks watches.json saves nothing, with the exact problem", async () => {
    const result = await bash("echo 'kept?' > ~/ok.md; printf '[{\"timeout\": \"2026-10-25 10:00\", \"note\": \"x\", \"when\": []},]' > ~/watches.json");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/\nerror: changes not saved: watches\.json line 1, column \d+: /u);
    expect(await herFile(w, "ella", "home/ok.md")).toBeUndefined();
    expect(await herFile(w, "ella", "home/watches.json")).toBeUndefined();
  });

  it("a change set over her home's limits saves nothing", async () => {
    w.setConfig((config) => ({ ...config, life: { ...config.life, home: { ...config.life.home, maxFiles: 10 } } }));
    try {
      const result = await bash("for i in 1 2 3 4 5 6 7 8 9 10; do echo $i > n$i.md; done");
      expect(result.text).toMatch(/error: changes not saved: your home has 10 files already/u);
      expect(await herFile(w, "ella", "home/n1.md")).toBeUndefined();
    } finally {
      w.setConfig((config) => ({ ...config, life: { ...config.life, home: { ...config.life.home, maxFiles: 2000 } } }));
    }
  });

  it("the image command works on her pictures without Python packages", async () => {
    // Python's standard library can write a PNG (zlib, struct); there is no PIL.
    const made = await py("import zlib, struct\ndef chunk(t, d):\n    c = struct.pack('>I', len(d)) + t + d\n    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)\nraw = b''.join(b'\\x00' + b'\\xff\\x00\\x00' * 8 for _ in range(6))\nopen('/tmp/red.png', 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 8, 6, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))\ntry:\n    import PIL\n    print('PIL')\nexcept ImportError:\n    print('no PIL')\n");
    expect(made.text).toContain("no PIL");
    expect(exitOf(made.text)).toBe(0);
    const info = await bash("image info /tmp/red.png && image crop /tmp/red.png /tmp/crop.png 4x3+2+1 && image info /tmp/crop.png && image convert /tmp/crop.png /tmp/crop.webp && image info /tmp/crop.webp");
    expect(info.text).toMatch(/png 8x6/u);
    expect(info.text).toMatch(/png 4x3/u);
    expect(info.text).toMatch(/webp 4x3/u);
    expect(info.text).toContain("changed:");
  });
});
