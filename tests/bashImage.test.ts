import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import omggif from "omggif";
import { IMAGE_HELP, IMAGE_MAX_PIXELS, runImageCommand, type ImageIo } from "../src/life/bash/imageCommand.js";

// --- in-memory virtual folder ---------------------------------------------------------------

type MemoryIo = ImageIo & { files: Map<string, Uint8Array>; writes: string[] };

function memoryIo(initial: Record<string, Uint8Array> = {}): MemoryIo {
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(initial)) files.set(`/home/her/${name}`, data);
  const writes: string[] = [];
  return {
    files,
    writes,
    resolve: (path) => (path.startsWith("/") ? path : `/home/her/${path}`),
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) throw new Error(`${path}: No such file or directory`);
      return data;
    },
    async writeFile(path, data) {
      writes.push(path);
      files.set(path, data);
    },
  };
}

function file(io: MemoryIo, name: string): Uint8Array {
  const data = io.files.get(`/home/her/${name}`);
  if (data === undefined) throw new Error(`missing ${name}`);
  return data;
}

// --- test-local PNG writer (any color type, bit depth, all filters, Adam7) --------------------

type Rgba = [number, number, number, number];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7: Array<[number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Packs raw samples (per pixel, `channels` values at `bitDepth`), rows filtered with types 0..4 in turn. */
function makePng(options: {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  interlace?: boolean;
  sample: (x: number, y: number) => number[];
  plte?: number[];
  trns?: number[];
  declaredWidth?: number;
  declaredHeight?: number;
}): Buffer {
  const { width, height, colorType, bitDepth } = options;
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const passes = options.interlace ? ADAM7 : [[0, 0, 1, 1] as [number, number, number, number]];
  const rows: number[] = [];
  let rowNumber = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (pw === 0 || ph === 0) continue;
    const stride = Math.ceil((pw * channels * bitDepth) / 8);
    let previous = new Uint8Array(stride);
    for (let r = 0; r < ph; r++) {
      const line = new Uint8Array(stride);
      let bit = 0;
      for (let c = 0; c < pw; c++) {
        for (const value of options.sample(x0 + c * dx, y0 + r * dy)) {
          if (bitDepth === 16) {
            line[bit >> 3] = value >> 8;
            line[(bit >> 3) + 1] = value & 255;
          } else if (bitDepth === 8) {
            line[bit >> 3] = value;
          } else {
            line[bit >> 3] |= value << (8 - bitDepth - (bit & 7));
          }
          bit += bitDepth;
        }
      }
      const filter = rowNumber++ % 5;
      rows.push(filter);
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous[i];
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        rows.push((line[i] - predictor) & 255);
      }
      previous = line;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.declaredWidth ?? width, 0);
  header.writeUInt32BE(options.declaredHeight ?? height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = options.interlace ? 1 : 0;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (options.plte) parts.push(chunk("PLTE", Uint8Array.from(options.plte)));
  if (options.trns) parts.push(chunk("tRNS", Uint8Array.from(options.trns)));
  parts.push(chunk("IDAT", deflateSync(Uint8Array.from(rows))), chunk("IEND", new Uint8Array(0)));
  return Buffer.concat(parts);
}

function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
  return makePng({ width, height, colorType: 6, bitDepth: 8, sample: pixel });
}

/** Decodes any input through the command itself (`convert` to PNG) and reads the pixels back. */
async function pixelsOf(io: MemoryIo, name: string): Promise<{ width: number; height: number; at: (x: number, y: number) => Rgba }> {
  const result = await runImageCommand(["convert", name, "__probe.png"], io);
  expect(result.exitCode, result.stderr).toBe(0);
  return readPng(file(io, "__probe.png"));
}

/** Reads the 8-bit RGB/RGBA non-interlaced PNGs the command writes. */
function readPng(png: Uint8Array): { width: number; height: number; at: (x: number, y: number) => Rgba } {
  const buffer = Buffer.from(png);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  expect(buffer[24]).toBe(8);
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(buffer.subarray(pos + 8, pos + 8 + length));
    pos += length + 12;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= channels ? out[y * stride + i - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = i >= channels && y > 0 ? out[(y - 1) * stride + i - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      out[y * stride + i] = (value + predictor) & 255;
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * stride + x * channels;
      return [out[o], out[o + 1], out[o + 2], channels === 4 ? out[o + 3] : 255];
    },
  };
}

// A 4x3 picture with twelve distinct opaque colors: pixel (x, y) = [x*60+10, y*100+20, 200 - x*10 - y*40, 255].
const colorAt = (x: number, y: number): Rgba => [x * 60 + 10, y * 100 + 20, 200 - x * 10 - y * 40, 255];
const small = () => rgbaPng(4, 3, colorAt);

function gradient(width: number, height: number, alpha = false): Buffer {
  return rgbaPng(width, height, (x, y) => [(x * 255) / (width - 1), (y * 255) / (height - 1), ((x + y) * 7) & 255, alpha && x < width / 2 ? 0 : 255].map(Math.round) as Rgba);
}

// --- tests -------------------------------------------------------------------------------------

describe("image info", () => {
  it("describes each format from its bytes", async () => {
    const io = memoryIo({ "a.png": gradient(64, 48, true), "b.png": gradient(64, 48) });
    for (const [out, args] of [["c.jpg", []], ["d.webp", []], ["e.gif", []]] as Array<[string, string[]]>) {
      expect((await runImageCommand(["convert", "b.png", out, ...args], io)).exitCode).toBe(0);
    }
    // Content wins over the extension.
    io.files.set("/home/her/misnamed.png", file(io, "c.jpg"));
    const result = await runImageCommand(["info", "a.png", "b.png", "c.jpg", "d.webp", "e.gif", "misnamed.png"], io);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^a\.png: png 64x48, \d+(\.\d)? (B|KB), alpha$/);
    expect(lines[1]).toMatch(/^b\.png: png 64x48, \d+(\.\d)? (B|KB)$/);
    expect(lines[2]).toMatch(/^c\.jpg: jpeg 64x48, /);
    expect(lines[3]).toMatch(/^d\.webp: webp 64x48, /);
    expect(lines[4]).toMatch(/^e\.gif: gif 64x48, /);
    expect(lines[5]).toMatch(/^misnamed\.png: jpeg 64x48, /);
    expect(io.writes.every((path) => !path.includes("info"))).toBe(true);
  });

  it("formats sizes in B, KB and MB", async () => {
    const io = memoryIo({ "tiny.png": rgbaPng(1, 1, () => [1, 2, 3, 255]) });
    const tiny = await runImageCommand(["info", "tiny.png"], io);
    expect(tiny.stdout).toMatch(/^tiny\.png: png 1x1, \d+ B\n$/);
    let seed = 12345;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed & 255;
    };
    const noisy = rgbaPng(800, 600, () => [random(), random(), random(), 255]);
    io.files.set("/home/her/noisy.png", noisy);
    const result = await runImageCommand(["info", "noisy.png"], io);
    expect(result.stdout).toMatch(/^noisy\.png: png 800x600, \d+\.\d MB\n$/);
    const kilo = await runImageCommand(["info", "s.png"], memoryIo({ "s.png": gradient(64, 64) }));
    expect(kilo.stdout).toMatch(/^s\.png: png 64x64, \d+\.\d KB\n$/);
  });

  it("reports a missing file and keeps going", async () => {
    const io = memoryIo({ "a.png": small() });
    const result = await runImageCommand(["info", "nope.png", "a.png"], io);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("image: /home/her/nope.png: No such file or directory\n");
    expect(result.stdout).toMatch(/^a\.png: png 4x3, /);
  });

  it("notes that an animated GIF keeps only its first frame", async () => {
    const buffer = new Uint8Array(4096);
    const writer = new omggif.GifWriter(buffer, 2, 2, { palette: [0xff0000, 0x00ff00] });
    writer.addFrame(0, 0, 2, 2, Uint8Array.from([0, 0, 0, 0]));
    writer.addFrame(0, 0, 2, 2, Uint8Array.from([1, 1, 1, 1]));
    const io = memoryIo({ "anim.gif": buffer.slice(0, writer.end()) });
    const result = await runImageCommand(["info", "anim.gif"], io);
    expect(result.stdout).toMatch(/^anim\.gif: gif 2x2, \d+ B, animated \(2 frames; only the first is used\)\n$/);
    await runImageCommand(["convert", "anim.gif", "first.png"], io);
    expect(readPng(file(io, "first.png")).at(1, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe("image convert", () => {
  it("round trips png -> jpg -> webp -> gif -> png keeping the dimensions", async () => {
    const io = memoryIo({ "start.png": gradient(37, 23) });
    const chain = ["start.png", "a.jpg", "b.webp", "c.gif", "d.png", "e.jpeg", "f.webp"];
    for (let i = 1; i < chain.length; i++) {
      const result = await runImageCommand(["convert", chain[i - 1], chain[i]], io);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^wrote ${chain[i].replace(".", "\\.")} \\(37x23, \\d+(\\.\\d)? (B|KB)\\)\\n$`));
    }
    const final = await pixelsOf(io, "f.webp");
    expect([final.width, final.height]).toEqual([37, 23]);
    // Colors survive the lossy chain roughly: the bottom-right corner is bright red-green.
    const [r, g] = final.at(36, 22);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
  });

  it("keeps exact colors and transparency through lossless WebP and small-palette GIF", async () => {
    const io = memoryIo({ "s.png": rgbaPng(4, 3, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : colorAt(x, y))) });
    await runImageCommand(["convert", "s.png", "s.webp"], io);
    await runImageCommand(["convert", "s.png", "s.gif"], io);
    for (const name of ["s.webp", "s.gif"]) {
      const image = await pixelsOf(io, name);
      expect(image.at(0, 0)[3], name).toBe(0);
      expect(image.at(2, 1), name).toEqual(colorAt(2, 1));
      expect(image.at(3, 2), name).toEqual(colorAt(3, 2));
    }
  });

  it("quantizes pictures with many colors for GIF", async () => {
    const io = memoryIo({ "g.png": gradient(200, 150, true) });
    expect((await runImageCommand(["convert", "g.png", "g.gif"], io)).exitCode).toBe(0);
    const original = readPng(file(io, "g.png"));
    const image = await pixelsOf(io, "g.gif");
    expect(image.at(10, 10)[3]).toBe(0);
    let worst = 0;
    for (let y = 0; y < 150; y += 7) {
      for (let x = 100; x < 200; x += 7) {
        const a = original.at(x, y);
        const b = image.at(x, y);
        expect(b[3]).toBe(255);
        worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      }
    }
    expect(worst).toBeLessThan(40);
  });

  it("composites transparency onto white for JPEG", async () => {
    const io = memoryIo({ "t.png": rgbaPng(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [0, 0, 255, 255])) });
    await runImageCommand(["convert", "t.png", "t.jpg"], io);
    const decoded = jpeg.decode(file(io, "t.jpg"), { useTArray: true, formatAsRGBA: true });
    const at = (x: number, y: number) => Array.from(decoded.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3));
    for (const value of at(2, 8)) expect(value).toBeGreaterThan(245);
    expect(at(13, 8)[2]).toBeGreaterThan(230);
    expect(at(13, 8)[0]).toBeLessThan(25);
  });

  it("uses --quality for JPEG and lossy WebP, lossless WebP otherwise", async () => {
    const noisy = rgbaPng(96, 96, (x, y) => [(x * 7919 + y * 104729) & 255, (x * y * 31) & 255, (x ^ y) & 255, 255]);
    const io = memoryIo({ "n.png": noisy });
    await runImageCommand(["convert", "n.png", "low.jpg", "--quality", "10"], io);
    await runImageCommand(["convert", "--quality=95", "n.png", "high.jpg"], io);
    expect(file(io, "low.jpg").length).toBeLessThan(file(io, "high.jpg").length);
    await runImageCommand(["convert", "n.png", "lossless.webp"], io);
    await runImageCommand(["convert", "n.png", "lossy.webp", "--quality", "50"], io);
    const fourcc = (name: string) => Buffer.from(file(io, name).subarray(12, 16)).toString("latin1");
    expect(fourcc("lossless.webp")).toBe("VP8L");
    expect(fourcc("lossy.webp")).toBe("VP8 ");
    const exact = await pixelsOf(io, "lossless.webp");
    const source = readPng(noisy);
    expect(exact.at(50, 41)).toEqual(source.at(50, 41));
  });
});

describe("image transforms on a 4x3 picture", () => {
  it("crops the right region", async () => {
    const io = memoryIo({ "s.png": small() });
    const result = await runImageCommand(["crop", "s.png", "c.png", "2x2+1+1"], io);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^wrote c\.png \(2x2, \d+ B\)\n$/);
    const image = readPng(file(io, "c.png"));
    expect([image.width, image.height]).toEqual([2, 2]);
    expect(image.at(0, 0)).toEqual(colorAt(1, 1));
    expect(image.at(1, 1)).toEqual(colorAt(2, 2));
    await runImageCommand(["crop", "s.png", "corner.png", "1x2"], io);
    const corner = readPng(file(io, "corner.png"));
    expect([corner.width, corner.height]).toEqual([1, 2]);
    expect(corner.at(0, 1)).toEqual(colorAt(0, 1));
  });

  it("rotates clockwise", async () => {
    const io = memoryIo({ "s.png": small() });
    await runImageCommand(["rotate", "s.png", "r90.png", "90"], io);
    const r90 = readPng(file(io, "r90.png"));
    expect([r90.width, r90.height]).toEqual([3, 4]);
    expect(r90.at(2, 0)).toEqual(colorAt(0, 0)); // top-left goes to top-right
    expect(r90.at(0, 0)).toEqual(colorAt(0, 2)); // bottom-left goes to top-left
    expect(r90.at(0, 3)).toEqual(colorAt(3, 2));
    await runImageCommand(["rotate", "s.png", "r180.png", "180"], io);
    const r180 = readPng(file(io, "r180.png"));
    expect([r180.width, r180.height]).toEqual([4, 3]);
    expect(r180.at(3, 2)).toEqual(colorAt(0, 0));
    for (const degrees of ["270", "-90"]) {
      await runImageCommand(["rotate", "s.png", "r270.png", degrees], io);
      const r270 = readPng(file(io, "r270.png"));
      expect([r270.width, r270.height]).toEqual([3, 4]);
      expect(r270.at(0, 3)).toEqual(colorAt(0, 0)); // top-left goes to bottom-left
      expect(r270.at(0, 0)).toEqual(colorAt(3, 0));
    }
  });

  it("flips horizontally and vertically", async () => {
    const io = memoryIo({ "s.png": small() });
    await runImageCommand(["flip", "s.png", "h.png", "horizontal"], io);
    await runImageCommand(["flip", "s.png", "v.png", "v"], io);
    const h = readPng(file(io, "h.png"));
    const v = readPng(file(io, "v.png"));
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        expect(h.at(x, y)).toEqual(colorAt(3 - x, y));
        expect(v.at(x, y)).toEqual(colorAt(x, 2 - y));
      }
    }
  });

  it("resizes with every size form", async () => {
    const io = memoryIo({ "g.png": gradient(80, 60) });
    const cases: Array<[string, number, number]> = [
      ["40x10", 40, 10],
      ["20", 20, 15],
      ["20x", 20, 15],
      ["x30", 40, 30],
      ["50%", 40, 30],
      ["250%", 200, 150],
      ["7x3", 7, 3],
    ];
    for (const [size, width, height] of cases) {
      const result = await runImageCommand(["resize", "g.png", "out.png", size], io);
      expect(result.exitCode, `${size}: ${result.stderr}`).toBe(0);
      const image = readPng(file(io, "out.png"));
      expect([image.width, image.height], size).toEqual([width, height]);
    }
  });

  it("produces sensible pixels when resizing", async () => {
    const io = memoryIo({
      "solid.png": rgbaPng(50, 40, () => [12, 200, 99, 255]),
      "halves.png": rgbaPng(40, 20, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])),
      "holes.png": rgbaPng(40, 40, (x) => (x % 2 === 0 ? [0, 255, 0, 255] : [0, 0, 0, 0])),
    });
    for (const size of ["7x9", "300%", "13%"]) {
      await runImageCommand(["resize", "solid.png", "s.png", size], io);
      const image = readPng(file(io, "s.png"));
      expect(image.at(0, 0)).toEqual([12, 200, 99, 255]);
      expect(image.at(image.width - 1, image.height - 1)).toEqual([12, 200, 99, 255]);
    }
    await runImageCommand(["resize", "halves.png", "h.png", "10x5"], io);
    const halves = readPng(file(io, "h.png"));
    expect(halves.at(0, 2)).toEqual([255, 0, 0, 255]);
    expect(halves.at(9, 2)).toEqual([0, 0, 255, 255]);
    // Shrinking a half-transparent pattern averages alpha without darkening the color.
    await runImageCommand(["resize", "holes.png", "o.png", "10x10"], io);
    const holes = readPng(file(io, "o.png"));
    const [r, g, b, a] = holes.at(5, 5);
    expect([r, g, b]).toEqual([0, 255, 0]);
    expect(a).toBeGreaterThan(110);
    expect(a).toBeLessThan(145);
  });
});

describe("PNG decoding", () => {
  async function decode(png: Buffer): Promise<ReturnType<typeof readPng>> {
    const io = memoryIo({ "in.png": png });
    return pixelsOf(io, "in.png");
  }

  it("decodes Adam7 interlaced images like their plain twins", async () => {
    for (const [width, height] of [[13, 11], [1, 1], [3, 9], [9, 2]]) {
      const sample = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * y * 5) & 255, (x * 3 + y * 50) & 255];
      const plain = await decode(makePng({ width, height, colorType: 2, bitDepth: 8, sample }));
      const interlaced = await decode(makePng({ width, height, colorType: 2, bitDepth: 8, sample, interlace: true }));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          expect(interlaced.at(x, y), `${width}x${height} at ${x},${y}`).toEqual([...sample(x, y), 255]);
          expect(plain.at(x, y)).toEqual([...sample(x, y), 255]);
        }
      }
    }
  });

  it("decodes palette images with tRNS, including low bit depths and interlace", async () => {
    const plte = [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9];
    const trns = [0, 128];
    for (const bitDepth of [2, 4, 8]) {
      for (const interlace of [false, true]) {
        const image = await decode(makePng({ width: 5, height: 4, colorType: 3, bitDepth, interlace, plte, trns, sample: (x, y) => [(x + y) % 4] }));
        expect(image.at(0, 0)).toEqual([255, 0, 0, 0]);
        expect(image.at(1, 0)).toEqual([0, 255, 0, 128]);
        expect(image.at(2, 0)).toEqual([0, 0, 255, 255]);
        expect(image.at(3, 0)).toEqual([9, 9, 9, 255]);
        expect(image.at(4, 3)).toEqual([9, 9, 9, 255]);
        expect(image.at(4, 2)).toEqual([0, 0, 255, 255]);
      }
    }
  });

  it("decodes 16-bit images and their tRNS", async () => {
    const rgba16 = await decode(makePng({ width: 3, height: 2, colorType: 6, bitDepth: 16, sample: (x, y) => [x * 30000, y * 60000, 0x1234, x === 2 ? 0x8000 : 0xffff] }));
    expect(rgba16.at(1, 1)).toEqual([117, 234, 0x12, 255]);
    expect(rgba16.at(2, 0)).toEqual([234, 0, 0x12, 128]);
    const gray16 = await decode(makePng({ width: 3, height: 1, colorType: 0, bitDepth: 16, trns: [0x12, 0x34], sample: (x) => [[0xffff, 0x1234, 0x1235][x]] }));
    expect(gray16.at(0, 0)).toEqual([255, 255, 255, 255]);
    expect(gray16.at(1, 0)[3]).toBe(0);
    expect(gray16.at(2, 0)).toEqual([0x12, 0x12, 0x12, 255]);
    const rgb16 = await decode(makePng({ width: 2, height: 1, colorType: 2, bitDepth: 16, trns: [0, 1, 0, 2, 0, 3], sample: (x) => (x === 0 ? [1, 2, 3] : [1, 2, 4]) }));
    expect(rgb16.at(0, 0)[3]).toBe(0);
    expect(rgb16.at(1, 0)[3]).toBe(255);
    const grayAlpha16 = await decode(makePng({ width: 1, height: 1, colorType: 4, bitDepth: 16, sample: () => [0x4000, 0xff00] }));
    expect(grayAlpha16.at(0, 0)).toEqual([0x40, 0x40, 0x40, 0xff]);
  });

  it("decodes 1-, 2- and 4-bit grayscale (with tRNS) and 8-bit gray + alpha", async () => {
    const oneBit = await decode(makePng({ width: 11, height: 3, colorType: 0, bitDepth: 1, sample: (x, y) => [(x + y) % 2] }));
    expect(oneBit.at(0, 0)).toEqual([0, 0, 0, 255]);
    expect(oneBit.at(1, 0)).toEqual([255, 255, 255, 255]);
    expect(oneBit.at(10, 2)).toEqual([0, 0, 0, 255]);
    const oneBitTrns = await decode(makePng({ width: 9, height: 1, colorType: 0, bitDepth: 1, interlace: true, trns: [0, 1], sample: (x) => [x % 2] }));
    expect(oneBitTrns.at(1, 0)[3]).toBe(0);
    expect(oneBitTrns.at(8, 0)).toEqual([0, 0, 0, 255]);
    const twoBit = await decode(makePng({ width: 4, height: 1, colorType: 0, bitDepth: 2, sample: (x) => [x] }));
    expect([0, 1, 2, 3].map((x) => twoBit.at(x, 0)[0])).toEqual([0, 85, 170, 255]);
    const fourBit = await decode(makePng({ width: 3, height: 1, colorType: 0, bitDepth: 4, sample: (x) => [[0, 7, 15][x]] }));
    expect([0, 1, 2].map((x) => fourBit.at(x, 0)[0])).toEqual([0, 119, 255]);
    const grayAlpha = await decode(makePng({ width: 2, height: 1, colorType: 4, bitDepth: 8, sample: (x) => [100 + x, 50 * x] }));
    expect(grayAlpha.at(1, 0)).toEqual([101, 101, 101, 50]);
  });

  it("rejects truncated PNG data with a clear error", async () => {
    const png = gradient(30, 30);
    for (const cut of [png.length - 5, 60, 40, 20]) {
      const io = memoryIo({ "cut.png": png.subarray(0, cut) });
      const result = await runImageCommand(["convert", "cut.png", "out.png"], io);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^image: cut\.png: truncated PNG data/);
      expect(io.writes).toEqual([]);
    }
  });
});

describe("image errors", () => {
  async function failing(args: string[], files: Record<string, Uint8Array> = { "s.png": small() }): Promise<{ stderr: string }> {
    const io = memoryIo(files);
    const result = await runImageCommand(args, io);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^image: .+\n$/);
    expect(io.writes).toEqual([]);
    return result;
  }

  it("rejects bad crop geometry and out-of-bounds boxes", async () => {
    expect((await failing(["crop", "s.png", "c.png", "banana"])).stderr).toContain('bad crop geometry "banana"');
    expect((await failing(["crop", "s.png", "c.png", "0x2+0+0"])).stderr).toContain("bad crop geometry");
    const outside = await failing(["crop", "s.png", "c.png", "3x2+2+0"]);
    expect(outside.stderr).toBe("image: crop box 3x2+2+0 lies outside the 4x3 image\n");
    expect((await failing(["crop", "s.png", "c.png", "1x1-1+0"])).stderr).toContain("outside the 4x3 image");
  });

  it("rejects bad resize sizes", async () => {
    expect((await failing(["resize", "s.png", "r.png", "big"])).stderr).toContain('bad size "big"');
    expect((await failing(["resize", "s.png", "r.png", "0x5"])).stderr).toContain("greater than zero");
    expect((await failing(["resize", "s.png", "r.png", "20000x10"])).stderr).toContain("at most 10000 pixels per side");
    expect((await failing(["resize", "s.png", "r.png", "300000%"])).stderr).toContain("too large");
  });

  it("supports only multiples of 90 degrees and h/v flips", async () => {
    expect((await failing(["rotate", "s.png", "r.png", "45"])).stderr).toContain("only multiples of 90 degrees are supported");
    expect((await failing(["rotate", "s.png", "r.png", "ninety"])).stderr).toContain("only multiples of 90 degrees are supported");
    expect((await failing(["flip", "s.png", "f.png", "diagonal"])).stderr).toContain("horizontal (h) or vertical (v)");
  });

  it("rejects unknown output extensions", async () => {
    expect((await failing(["convert", "s.png", "s.bmp"])).stderr).toContain('unsupported output format ".bmp"');
    expect((await failing(["convert", "s.png", "noext"])).stderr).toContain("needs an extension");
  });

  it("rejects corrupt and unknown input", async () => {
    const garbage = Uint8Array.from({ length: 200 }, (_, i) => (i * 73) & 255);
    expect((await failing(["convert", "x.png", "y.png"], { "x.png": garbage })).stderr).toBe("image: x.png: not a PNG, JPEG, WebP or GIF image\n");
    const jpegHead = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
    expect((await failing(["convert", "x.jpg", "y.png"], { "x.jpg": jpegHead })).stderr).toMatch(/^image: x\.jpg: corrupt JPEG data/);
    const gifHead = Uint8Array.from(Buffer.from("GIF89a\x02\x00\x02\x00\x00\x00\x00", "latin1"));
    expect((await failing(["convert", "x.gif", "y.png"], { "x.gif": gifHead })).stderr).toMatch(/^image: x\.gif: /);
    const webpHead = Uint8Array.from(Buffer.from("RIFF\x10\x00\x00\x00WEBPJUNK", "latin1"));
    expect((await failing(["convert", "x.webp", "y.png"], { "x.webp": webpHead })).stderr).toMatch(/^image: x\.webp: corrupt WebP data/);
    const png = makePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, sample: () => [1, 2, 3] });
    const cutInIdat = png.subarray(0, png.indexOf("IDAT") + 6);
    expect((await failing(["info", "c.png"], { "c.png": cutInIdat })).stderr).toBe("image: c.png: truncated PNG data (the IDAT chunk is cut off)\n");
    const badZlib = Buffer.from(png);
    badZlib[png.indexOf("IDAT") + 4] ^= 0xff; // breaks the zlib header
    expect((await failing(["info", "c.png"], { "c.png": badZlib })).stderr).toMatch(/^image: c\.png: corrupt PNG data/);
    expect((await failing(["convert", "missing.png", "y.png"])).stderr).toBe("image: /home/her/missing.png: No such file or directory\n");
  });

  it("refuses images above IMAGE_MAX_PIXELS before decoding", async () => {
    expect(IMAGE_MAX_PIXELS).toBe(40_000_000);
    // IHDR says 50000x50000 but the data is a single tiny row: it must never be inflated.
    const huge = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, sample: () => [0, 0, 0, 255], declaredWidth: 50_000, declaredHeight: 50_000 });
    const result = await failing(["convert", "huge.png", "out.png"], { "huge.png": huge });
    expect(result.stderr).toBe("image: huge.png: the image is 50000x50000, too large (at most 40,000,000 pixels)\n");
    expect((await failing(["info", "huge.png"], { "huge.png": huge })).stderr).toContain("too large");
    const gif = Uint8Array.from(Buffer.from("GIF89a\x50\xc3\x50\xc3\x00\x00\x00;", "latin1"));
    expect((await failing(["info", "huge.gif"], { "huge.gif": gif })).stderr).toContain("50000x50000, too large");
  });

  it("validates --quality", async () => {
    for (const value of ["0", "101", "abc", "50.5", "-5"]) {
      expect((await failing(["convert", "s.png", "s.jpg", "--quality", value])).stderr).toContain("--quality needs a whole number from 1 to 100");
    }
    expect((await failing(["convert", "s.png", "s.jpg", "--quality"])).stderr).toContain("--quality needs a whole number");
    expect((await failing(["convert", "s.png", "s.png", "--quality", "80"])).stderr).toContain("--quality only applies to .jpg/.jpeg and .webp output");
    const io = memoryIo({ "s.png": small() });
    for (const value of ["1", "100"]) expect((await runImageCommand(["convert", "s.png", "s.jpg", `--quality=${value}`], io)).exitCode).toBe(0);
  });
});

describe("image usage", () => {
  it("prints the help for image, image --help and image help", async () => {
    for (const args of [[], ["--help"], ["help"], ["-h"], ["crop", "--help"]]) {
      const result = await runImageCommand(args, memoryIo());
      expect(result).toEqual({ stdout: IMAGE_HELP, stderr: "", exitCode: 0 });
    }
    expect(IMAGE_HELP).toContain("image crop IN OUT WxH[+X+Y]");
  });

  it("exits 2 with the help on stderr for usage errors", async () => {
    const cases = [["paint", "a.png"], ["crop", "a.png", "b.png"], ["convert", "a.png"], ["rotate", "a.png", "b.png", "90", "extra"], ["info"], ["convert", "a.png", "b.png", "--fast"]];
    for (const args of cases) {
      const io = memoryIo({ "a.png": small() });
      const result = await runImageCommand(args, io);
      expect(result.exitCode, args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^image: .+\n\n/);
      expect(result.stderr.endsWith(IMAGE_HELP)).toBe(true);
      expect(io.writes).toEqual([]);
    }
  });

  it("treats a negative angle as an argument, not an option", async () => {
    const io = memoryIo({ "a.png": small() });
    const result = await runImageCommand(["rotate", "a.png", "b.png", "-90"], io);
    expect(result.exitCode).toBe(0);
  });
});
