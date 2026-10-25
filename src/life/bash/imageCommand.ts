// The `image` built-in of her simulated bash: inspect, crop, resize, rotate, flip and convert the
// pictures in her virtual folder ("crop this picture"). It runs inside the bash worker thread and
// is loaded there by Node's native type stripping, so this file imports only npm packages and
// `node:` builtins and uses erasable TypeScript only. Bytes come from and go to the virtual
// filesystem through the injected `ImageIo`, never the real disk. Codecs are pure JavaScript: our
// own PNG over node:zlib, jpeg-js, omggif (animated GIFs keep only their first frame) and
// @stacksjs/ts-webp (animated WebPs likewise). Every decode checks the declared size against
// IMAGE_MAX_PIXELS before allocating pixels.

import { crc32, deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import omggif from "omggif";
import { decode as decodeWebpBytes, decodeAnimation as decodeWebpAnimation, encode as encodeWebpBytes } from "@stacksjs/ts-webp";

export type ImageIo = {
  /** Reads a file of the virtual filesystem (path already resolved to absolute by the caller via `resolve`). Throws an Error whose message is shown to the user when missing. */
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Resolves a user-given path (relative to the shell's cwd, `~` handled by the shell) to absolute. */
  resolve(path: string): string;
};

export type ImageResult = { stdout: string; stderr: string; exitCode: number };

/** Images above this many pixels are refused before decoding or creating them. */
export const IMAGE_MAX_PIXELS = 40_000_000;

/** Largest side `image resize` produces. */
const MAX_RESIZE_SIDE = 10_000;
const DEFAULT_QUALITY = 85;

export const IMAGE_HELP = `usage: image COMMAND ARGS... [--quality N]

  image info FILE...              format, size, file size and transparency of pictures
  image crop IN OUT WxH[+X+Y]     keep the W by H box whose top-left corner is at X,Y (default 0,0)
  image resize IN OUT SIZE        SIZE is WxH (exact), W or Wx or xH (keeps the aspect ratio) or N%
  image rotate IN OUT DEGREES     clockwise by 90, 180, 270 or -90
  image flip IN OUT h|v           mirror horizontally (h, horizontal) or vertically (v, vertical)
  image convert IN OUT            save in another format

The OUT extension picks the format: .png, .jpg/.jpeg, .webp or .gif.
--quality N (1-100, default 85) applies to .jpg and .webp; .webp is lossless unless --quality is given.
JPEG has no transparency (transparent parts become white); GIF keeps at most 256 colors.
Animated GIF and WebP files keep only their first frame.

examples:
  image info cake.png
  image crop cake.png slice.png 200x150+40+30
  image resize cake.jpg small.jpg 50%
  image convert cake.png cake.webp --quality 80
`;

type Raster = { width: number; height: number; data: Uint8Array };
type Format = "png" | "jpeg" | "gif" | "webp";
type Decoded = { raster: Raster; format: Format; frames: number };

/** A failure shown as `image: <message>` with exit code 1. */
class ImageError extends Error {}
/** A malformed command line: exit code 2 with the help text. */
class UsageError extends Error {}

export async function runImageCommand(args: string[], io: ImageIo): Promise<ImageResult> {
  try {
    return await run(args, io);
  } catch (error) {
    if (error instanceof UsageError) return { stdout: "", stderr: `image: ${error.message}\n\n${IMAGE_HELP}`, exitCode: 2 };
    return { stdout: "", stderr: `image: ${messageOf(error)}\n`, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Command line

type Options = { positional: string[]; quality: number | null; help: boolean };

const USAGES: Record<string, { args: number; usage: string }> = {
  crop: { args: 3, usage: "image crop IN OUT WxH+X+Y" },
  resize: { args: 3, usage: "image resize IN OUT SIZE" },
  rotate: { args: 3, usage: "image rotate IN OUT DEGREES" },
  flip: { args: 3, usage: "image flip IN OUT horizontal|vertical" },
  convert: { args: 2, usage: "image convert IN OUT" },
};

async function run(args: string[], io: ImageIo): Promise<ImageResult> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") return { stdout: IMAGE_HELP, stderr: "", exitCode: 0 };
  if (command !== "info" && USAGES[command] === undefined) throw new UsageError(`unknown command "${command}"`);
  const options = parseOptions(rest);
  if (options.help) return { stdout: IMAGE_HELP, stderr: "", exitCode: 0 };
  if (command === "info") {
    if (options.positional.length === 0) throw new UsageError("usage: image info FILE...");
    return info(options.positional, io);
  }
  const spec = USAGES[command];
  if (options.positional.length !== spec.args) throw new UsageError(`usage: ${spec.usage}`);
  const [input, output, argument] = options.positional;
  const outFormat = formatForOutput(output);
  if (options.quality !== null && outFormat !== "jpeg" && outFormat !== "webp") {
    throw new ImageError("--quality only applies to .jpg/.jpeg and .webp output");
  }
  // Check the argument's shape before reading anything; bounds are checked against the image.
  let transform: (raster: Raster) => Raster;
  switch (command) {
    case "crop": {
      const box = parseCropGeometry(argument);
      transform = (raster) => crop(raster, box);
      break;
    }
    case "resize": {
      const size = parseResizeSize(argument);
      transform = (raster) => {
        const [width, height] = resizeTarget(raster, size);
        return resize(raster, width, height);
      };
      break;
    }
    case "rotate": {
      const degrees = parseRotation(argument);
      transform = (raster) => rotate(raster, degrees);
      break;
    }
    case "flip": {
      const axis = parseFlip(argument);
      transform = (raster) => flip(raster, axis);
      break;
    }
    default:
      transform = (raster) => raster;
  }
  const decoded = decodeImage(await io.readFile(io.resolve(input)), input);
  const result = transform(decoded.raster);
  const bytes = encodeImage(result, outFormat, options.quality);
  await io.writeFile(io.resolve(output), bytes);
  return { stdout: `wrote ${output} (${result.width}x${result.height}, ${formatSize(bytes.length)})\n`, stderr: "", exitCode: 0 };
}

function parseOptions(args: string[]): Options {
  const positional: string[] = [];
  let quality: number | null = null;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--quality" || arg.startsWith("--quality=")) {
      const value = arg === "--quality" ? args[++i] : arg.slice("--quality=".length);
      quality = parseQuality(value);
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, quality, help };
}

function parseQuality(value: string | undefined): number {
  if (value === undefined || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    throw new ImageError("--quality needs a whole number from 1 to 100");
  }
  return Number(value);
}

function formatForOutput(path: string): Format {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (extension) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "webp":
      return "webp";
    case "gif":
      return "gif";
    default:
      throw new ImageError(
        extension === ""
          ? `${path}: the output needs an extension (.png, .jpg, .jpeg, .webp or .gif)`
          : `${path}: unsupported output format ".${extension}" (use .png, .jpg, .jpeg, .webp or .gif)`,
      );
  }
}

type CropBox = { width: number; height: number; x: number; y: number };

function parseCropGeometry(text: string): CropBox {
  const match = /^(\d+)x(\d+)(?:([+-]\d+)([+-]\d+))?$/i.exec(text);
  if (match === null) throw new ImageError(`bad crop geometry "${text}" (expected WxH+X+Y, like 200x150+40+30)`);
  const box = { width: Number(match[1]), height: Number(match[2]), x: Number(match[3] ?? 0), y: Number(match[4] ?? 0) };
  if (box.width === 0 || box.height === 0) throw new ImageError(`bad crop geometry "${text}" (width and height must be at least 1)`);
  return box;
}

type ResizeSize = { kind: "exact"; width: number; height: number } | { kind: "width"; width: number } | { kind: "height"; height: number } | { kind: "percent"; percent: number };

function parseResizeSize(text: string): ResizeSize {
  let match: RegExpExecArray | null;
  let size: ResizeSize | null = null;
  if ((match = /^(\d+)x(\d+)$/i.exec(text)) !== null) size = { kind: "exact", width: Number(match[1]), height: Number(match[2]) };
  else if ((match = /^(\d+)x?$/i.exec(text)) !== null) size = { kind: "width", width: Number(match[1]) };
  else if ((match = /^x(\d+)$/i.exec(text)) !== null) size = { kind: "height", height: Number(match[1]) };
  else if ((match = /^(\d+(?:\.\d+)?)%$/.exec(text)) !== null) size = { kind: "percent", percent: Number(match[1]) };
  if (size === null) throw new ImageError(`bad size "${text}" (expected WxH, W, xH or N%, like 640x480, 640, x480 or 50%)`);
  const values = size.kind === "exact" ? [size.width, size.height] : size.kind === "width" ? [size.width] : size.kind === "height" ? [size.height] : [size.percent];
  if (values.some((value) => !(value > 0))) throw new ImageError(`bad size "${text}" (must be greater than zero)`);
  return size;
}

function resizeTarget(raster: Raster, size: ResizeSize): [number, number] {
  const { width, height } = raster;
  let target: [number, number];
  switch (size.kind) {
    case "exact":
      target = [size.width, size.height];
      break;
    case "width":
      target = [size.width, Math.max(1, Math.round((height * size.width) / width))];
      break;
    case "height":
      target = [Math.max(1, Math.round((width * size.height) / height)), size.height];
      break;
    case "percent":
      target = [Math.max(1, Math.round((width * size.percent) / 100)), Math.max(1, Math.round((height * size.percent) / 100))];
      break;
  }
  if (target[0] > MAX_RESIZE_SIDE || target[1] > MAX_RESIZE_SIDE) {
    throw new ImageError(`resizing to ${target[0]}x${target[1]} is too large (at most ${MAX_RESIZE_SIDE} pixels per side)`);
  }
  checkPixels(target[0], target[1], "the resized image");
  return target;
}

function parseRotation(text: string): number {
  if (!/^[+-]?\d+$/.test(text) || Number(text) % 90 !== 0) {
    throw new ImageError(`cannot rotate by "${text}": only multiples of 90 degrees are supported (90, 180, 270, -90)`);
  }
  return ((Number(text) % 360) + 360) % 360;
}

function parseFlip(text: string): "horizontal" | "vertical" {
  const lower = text.toLowerCase();
  if (lower === "h" || lower === "horizontal") return "horizontal";
  if (lower === "v" || lower === "vertical") return "vertical";
  throw new ImageError(`cannot flip "${text}": use horizontal (h) or vertical (v)`);
}

// ---------------------------------------------------------------------------------------------
// info

async function info(files: string[], io: ImageIo): Promise<ImageResult> {
  let stdout = "";
  let stderr = "";
  for (const file of files) {
    try {
      const bytes = await io.readFile(io.resolve(file));
      const decoded = decodeImage(bytes, file);
      const { width, height } = decoded.raster;
      const alpha = !isOpaque(decoded.raster) ? ", alpha" : "";
      const animated = decoded.frames > 1 ? `, animated (${decoded.frames} frames; only the first is used)` : "";
      stdout += `${file}: ${decoded.format} ${width}x${height}, ${formatSize(bytes.length)}${alpha}${animated}\n`;
    } catch (error) {
      stderr += `image: ${messageOf(error)}\n`;
    }
  }
  return { stdout, stderr, exitCode: stderr === "" ? 0 : 1 };
}

// ---------------------------------------------------------------------------------------------
// Decoding

function detectFormat(bytes: Uint8Array): Format | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8" && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

const FORMAT_NAMES: Record<Format, string> = { png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };

function decodeImage(bytes: Uint8Array, name: string): Decoded {
  const format = detectFormat(bytes);
  if (format === null) throw new ImageError(`${name}: not a PNG, JPEG, WebP or GIF image`);
  try {
    switch (format) {
      case "png":
        return { raster: decodePng(bytes), format, frames: 1 };
      case "jpeg":
        return { raster: decodeJpeg(bytes), format, frames: 1 };
      case "gif":
        return { ...decodeGif(bytes), format };
      case "webp":
        return { ...decodeWebp(bytes), format };
    }
  } catch (error) {
    if (error instanceof ImageError) throw new ImageError(`${name}: ${error.message}`);
    throw new ImageError(`${name}: corrupt ${FORMAT_NAMES[format]} data (${messageOf(error)})`);
  }
}

function checkPixels(width: number, height: number, what: string): void {
  if (!(width >= 1 && height >= 1)) throw new ImageError(`${what} has an invalid size ${width}x${height}`);
  if (width * height > IMAGE_MAX_PIXELS) {
    throw new ImageError(`${what} is ${width}x${height}, too large (at most ${IMAGE_MAX_PIXELS.toLocaleString("en-US")} pixels)`);
  }
}

// --- PNG ---

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; interlace: number };

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Adam7 passes: [x0, y0, dx, dy]. */
const ADAM7: Array<[number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function decodePng(bytes: Uint8Array): Raster {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  let pos = 8;
  while (!ended) {
    if (pos + 8 > bytes.length) throw new ImageError("truncated PNG data (the file ends before its IEND chunk)");
    const length = view.getUint32(pos);
    const type = ascii(bytes, pos + 4, 4);
    const start = pos + 8;
    if (length > 0x7fffffff || start + length + 4 > bytes.length) throw new ImageError(`truncated PNG data (the ${type} chunk is cut off)`);
    const data = bytes.subarray(start, start + length);
    pos = start + length + 4; // CRCs are not checked.
    if (header === null && type !== "IHDR") throw new ImageError("corrupt PNG data (IHDR is not the first chunk)");
    switch (type) {
      case "IHDR":
        header = parsePngHeader(data);
        break;
      case "PLTE":
        if (length % 3 !== 0 || length > 768) throw new ImageError("corrupt PNG data (bad palette)");
        palette = data;
        break;
      case "tRNS":
        transparency = data;
        break;
      case "IDAT":
        idat.push(data);
        break;
      case "IEND":
        ended = true;
        break;
      default:
        break; // Ancillary chunks (and unknown ones) are ignored.
    }
  }
  if (header === null) throw new ImageError("corrupt PNG data (no IHDR chunk)");
  if (idat.length === 0) throw new ImageError("corrupt PNG data (no image data)");
  if (header.colorType === 3 && palette === null) throw new ImageError("corrupt PNG data (palette image without a palette)");
  const { width, height, bitDepth, colorType } = header;
  const channels = PNG_CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const passes = header.interlace === 1 ? ADAM7 : [[0, 0, 1, 1] as [number, number, number, number]];
  const layout = passes.map(([x0, y0, dx, dy]) => {
    const passWidth = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const passHeight = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    const stride = Math.ceil((passWidth * bitsPerPixel) / 8);
    return { x0, y0, dx, dy, passWidth, passHeight, stride };
  });
  const expected = layout.reduce((sum, pass) => sum + (pass.passWidth === 0 ? 0 : pass.passHeight * (pass.stride + 1)), 0);
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 65_536 });
  } catch (error) {
    const message = messageOf(error);
    if (/unexpected end/i.test(message)) throw new ImageError("truncated PNG data (the compressed image data ends early)");
    throw new ImageError(`corrupt PNG data (${message})`);
  }
  if (raw.length < expected) throw new ImageError("truncated PNG data (not enough image data)");

  const out = new Uint8Array(width * height * 4);
  const maxSample = (1 << Math.min(bitDepth, 8)) - 1;
  const scale = bitDepth >= 8 ? 1 : 255 / maxSample;
  const transparentGray = transparency !== null && colorType === 0 && transparency.length >= 2 ? (transparency[0] << 8) | transparency[1] : -1;
  const transparentRgb =
    transparency !== null && colorType === 2 && transparency.length >= 6
      ? [(transparency[0] << 8) | transparency[1], (transparency[2] << 8) | transparency[3], (transparency[4] << 8) | transparency[5]]
      : null;
  const paletteEntries = palette === null ? 0 : palette.length / 3;
  let offset = 0;
  for (const pass of layout) {
    if (pass.passWidth === 0 || pass.passHeight === 0) continue;
    let previous: Uint8Array | null = null;
    for (let row = 0; row < pass.passHeight; row++) {
      const filter = raw[offset];
      const line = raw.subarray(offset + 1, offset + 1 + pass.stride);
      offset += pass.stride + 1;
      unfilterLine(filter, line, previous, bytesPerPixel);
      previous = line;
      const y = pass.y0 + row * pass.dy;
      for (let column = 0; column < pass.passWidth; column++) {
        const o = (y * width + pass.x0 + column * pass.dx) * 4;
        if (colorType === 3) {
          const index = readSample(line, column, bitDepth);
          if (palette !== null && index < paletteEntries) {
            out[o] = palette[index * 3];
            out[o + 1] = palette[index * 3 + 1];
            out[o + 2] = palette[index * 3 + 2];
            out[o + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255;
          } else {
            out[o + 3] = 255; // An out-of-range index reads as opaque black.
          }
        } else if (colorType === 0 || colorType === 4) {
          const gray = readSample(line, column * channels, bitDepth);
          const value = bitDepth === 16 ? gray >> 8 : Math.round(gray * scale);
          out[o] = value;
          out[o + 1] = value;
          out[o + 2] = value;
          if (colorType === 4) {
            const alpha = readSample(line, column * channels + 1, bitDepth);
            out[o + 3] = bitDepth === 16 ? alpha >> 8 : alpha;
          } else {
            out[o + 3] = gray === transparentGray ? 0 : 255;
          }
        } else {
          const r = readSample(line, column * channels, bitDepth);
          const g = readSample(line, column * channels + 1, bitDepth);
          const b = readSample(line, column * channels + 2, bitDepth);
          const shift = bitDepth === 16 ? 8 : 0;
          out[o] = r >> shift;
          out[o + 1] = g >> shift;
          out[o + 2] = b >> shift;
          if (colorType === 6) {
            out[o + 3] = readSample(line, column * channels + 3, bitDepth) >> shift;
          } else {
            out[o + 3] = transparentRgb !== null && r === transparentRgb[0] && g === transparentRgb[1] && b === transparentRgb[2] ? 0 : 255;
          }
        }
      }
    }
  }
  return { width, height, data: out };
}

function parsePngHeader(data: Uint8Array): PngHeader {
  if (data.length < 13) throw new ImageError("corrupt PNG data (short IHDR chunk)");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = { width: view.getUint32(0), height: view.getUint32(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
  const depths = PNG_DEPTHS[header.colorType];
  if (depths === undefined) throw new ImageError(`corrupt PNG data (unknown color type ${header.colorType})`);
  if (!depths.includes(header.bitDepth)) throw new ImageError(`corrupt PNG data (bit depth ${header.bitDepth} is invalid for color type ${header.colorType})`);
  if (data[10] !== 0 || data[11] !== 0 || header.interlace > 1) throw new ImageError("corrupt PNG data (unknown compression, filter or interlace method)");
  checkPixels(header.width, header.height, "the image");
  return header;
}

/** Reverses one scanline's filter in place. */
function unfilterLine(filter: number, line: Uint8Array, previous: Uint8Array | null, bpp: number): void {
  const length = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < length; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      if (previous === null) return;
      for (let i = 0; i < length; i++) line[i] = (line[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous === null ? 0 : previous[i];
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous === null ? 0 : previous[i];
        const upLeft = i >= bpp && previous !== null ? previous[i - bpp] : 0;
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new ImageError(`corrupt PNG data (unknown filter type ${filter})`);
  }
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

/** Reads sample number `index` of a scanline at the given bit depth. */
function readSample(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index];
  if (bitDepth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
  const bit = index * bitDepth;
  return (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
}

// --- JPEG ---

function decodeJpeg(bytes: Uint8Array): Raster {
  const size = jpegDimensions(bytes);
  if (size !== null) checkPixels(size.width, size.height, "the image");
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 40 });
  checkPixels(decoded.width, decoded.height, "the image");
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

/** Width and height from the first SOF segment, without decoding. */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 9 > bytes.length) return null;
      return { height: (bytes[pos + 5] << 8) | bytes[pos + 6], width: (bytes[pos + 7] << 8) | bytes[pos + 8] };
    }
    pos += 2 + length;
  }
  return null;
}

// --- GIF ---

function decodeGif(bytes: Uint8Array): { raster: Raster; frames: number } {
  if (bytes.length < 13) throw new ImageError("truncated GIF data");
  checkPixels(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8), "the image");
  const reader = new omggif.GifReader(bytes);
  const frames = reader.numFrames();
  if (frames === 0) throw new ImageError("corrupt GIF data (no frames)");
  const frame = reader.frameInfo(0);
  if (frame.x + frame.width > reader.width || frame.y + frame.height > reader.height) {
    throw new ImageError("corrupt GIF data (the first frame lies outside the image)");
  }
  if (frame.data_offset + frame.data_length > bytes.length) throw new ImageError("truncated GIF data");
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { raster: { width: reader.width, height: reader.height, data }, frames };
}

// --- WebP ---

function decodeWebp(bytes: Uint8Array): { raster: Raster; frames: number } {
  const header = webpHeader(bytes);
  if (header === null) throw new ImageError("corrupt WebP data (unknown or truncated header)");
  checkPixels(header.width, header.height, "the image");
  if (header.animated) {
    const animation = decodeWebpAnimation(bytes);
    const first = animation.frames[0];
    if (first === undefined) throw new ImageError("corrupt WebP data (no frames)");
    checkPixels(animation.width, animation.height, "the image");
    const canvas = new Uint8Array(animation.width * animation.height * 4);
    const frame = first.image;
    for (let y = 0; y < frame.height; y++) {
      const ty = first.y + y;
      if (ty >= animation.height) break;
      const width = Math.min(frame.width, animation.width - first.x);
      if (width <= 0) break;
      canvas.set(frame.data.subarray(y * frame.width * 4, (y * frame.width + width) * 4), (ty * animation.width + first.x) * 4);
    }
    return { raster: { width: animation.width, height: animation.height, data: canvas }, frames: animation.frames.length };
  }
  const decoded = decodeWebpBytes(bytes);
  checkPixels(decoded.width, decoded.height, "the image");
  if (decoded.data.length !== decoded.width * decoded.height * 4) throw new ImageError("corrupt WebP data (unexpected pixel data)");
  return { raster: { width: decoded.width, height: decoded.height, data: decoded.data }, frames: 1 };
}

/** Reads the canvas size from the first RIFF chunk (VP8, VP8L or VP8X) without decoding. */
function webpHeader(bytes: Uint8Array): { width: number; height: number; animated: boolean } | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff, animated: false };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === "VP8X") {
    return {
      width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
      height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
      animated: (bytes[20] & 0x02) !== 0,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Encoding

function encodeImage(raster: Raster, format: Format, quality: number | null): Uint8Array {
  checkPixels(raster.width, raster.height, "the result");
  switch (format) {
    case "png":
      return encodePng(raster);
    case "jpeg":
      return encodeJpeg(raster, quality ?? DEFAULT_QUALITY);
    case "gif":
      return encodeGif(raster);
    case "webp":
      return encodeWebp(raster, quality);
  }
}

function isOpaque(raster: Raster): boolean {
  const data = raster.data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

// --- PNG ---

function encodePng(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  const channels = isOpaque(raster) ? 3 : 4;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    if (channels === 4) {
      current.set(data.subarray(y * width * 4, (y + 1) * width * 4));
    } else {
      for (let x = 0, s = y * width * 4, d = 0; x < width; x++, s += 4, d += 3) {
        current[d] = data[s];
        current[d + 1] = data[s + 1];
        current[d + 2] = data[s + 2];
      }
    }
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? current[i - channels] : 0;
        const up = y > 0 ? previous[i] : 0;
        const upLeft = i >= channels && y > 0 ? previous[i - channels] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const value = (current[i] - predictor) & 0xff;
        out[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    const rowStart = y * (stride + 1);
    raw[rowStart] = best;
    raw.set(candidates[best], rowStart + 1);
    const swap = previous;
    previous = current;
    current = swap;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const parts = [Uint8Array.from(PNG_SIGNATURE), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

// --- JPEG ---

function encodeJpeg(raster: Raster, quality: number): Uint8Array {
  if (raster.width > 65_535 || raster.height > 65_535) throw new ImageError("JPEG images can be at most 65535 pixels per side");
  const data = isOpaque(raster) ? raster.data : flattenOnWhite(raster.data);
  return new Uint8Array(jpeg.encode({ data, width: raster.width, height: raster.height }, quality).data);
}

/** Composites RGBA onto white (JPEG has no alpha). */
function flattenOnWhite(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const background = 255 - alpha;
    out[i] = Math.round((data[i] * alpha + 255 * background) / 255);
    out[i + 1] = Math.round((data[i + 1] * alpha + 255 * background) / 255);
    out[i + 2] = Math.round((data[i + 2] * alpha + 255 * background) / 255);
    out[i + 3] = 255;
  }
  return out;
}

// --- WebP ---

function encodeWebp(raster: Raster, quality: number | null): Uint8Array {
  if (raster.width > 16_383 || raster.height > 16_383) throw new ImageError("WebP images can be at most 16383 pixels per side");
  const image = { data: raster.data, width: raster.width, height: raster.height, hasAlpha: !isOpaque(raster) };
  return quality === null ? encodeWebpBytes(image, { lossless: true }) : encodeWebpBytes(image, { lossless: false, quality });
}

// --- GIF ---

function encodeGif(raster: Raster): Uint8Array {
  const { width, height } = raster;
  if (width > 65_535 || height > 65_535) throw new ImageError("GIF images can be at most 65535 pixels per side");
  const { palette, indices, transparent } = quantize(raster);
  let size = 2;
  while (size < palette.length) size *= 2;
  while (palette.length < size) palette.push(0);
  const buffer = new Uint8Array(width * height * 2 + size * 3 + 4096);
  const writer = new omggif.GifWriter(buffer, width, height, { palette });
  writer.addFrame(0, 0, width, height, indices, transparent === null ? {} : { transparent });
  return buffer.slice(0, writer.end());
}

/**
 * Reduces the picture to at most 256 colors (one of them transparent when any pixel has alpha
 * below 128): the exact colors when there are few enough, otherwise median cut over a 5-bit
 * per channel histogram, without dithering.
 */
function quantize(raster: Raster): { palette: number[]; indices: Uint8Array; transparent: number | null } {
  const data = raster.data;
  const count = raster.width * raster.height;
  let hasTransparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) {
      hasTransparent = true;
      break;
    }
  }
  const limit = hasTransparent ? 255 : 256;
  const indices = new Uint8Array(count);

  const exact = new Map<number, number>();
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    if (data[i + 3] < 128) continue;
    const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (!exact.has(color)) {
      if (exact.size === limit) break;
      exact.set(color, exact.size);
    }
  }
  let palette: number[];
  let lookup: (r: number, g: number, b: number) => number;
  if (exact.size < limit || isExactFit(data, exact)) {
    palette = [...exact.keys()];
    lookup = (r, g, b) => exact.get((r << 16) | (g << 8) | b) ?? 0;
  } else {
    const result = medianCut(data, limit);
    palette = result.palette;
    const bins = result.binToIndex;
    lookup = (r, g, b) => bins[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
  }
  const transparent = hasTransparent ? palette.length : null;
  if (transparent !== null) palette.push(0);
  if (palette.length === 0) palette.push(0);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    indices[p] = transparent !== null && data[i + 3] < 128 ? transparent : lookup(data[i], data[i + 1], data[i + 2]);
  }
  return { palette, indices, transparent };
}

function isExactFit(data: Uint8Array, colors: Map<number, number>): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    if (!colors.has((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])) return false;
  }
  return true;
}

type ColorBox = { bins: number[]; count: number };

function medianCut(data: Uint8Array, limit: number): { palette: number[]; binToIndex: Uint8Array } {
  const counts = new Float64Array(32_768);
  const sums = new Float64Array(32_768 * 3);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const bin = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts[bin]++;
    sums[bin * 3] += data[i];
    sums[bin * 3 + 1] += data[i + 1];
    sums[bin * 3 + 2] += data[i + 2];
  }
  const used: number[] = [];
  let total = 0;
  for (let bin = 0; bin < counts.length; bin++) {
    if (counts[bin] > 0) {
      used.push(bin);
      total += counts[bin];
    }
  }
  const channel = (bin: number, c: number) => sums[bin * 3 + c] / counts[bin];
  const boxes: ColorBox[] = [{ bins: used, count: total }];
  const rangeOf = (box: ColorBox): { axis: number; range: number } => {
    let best = { axis: 0, range: -1 };
    for (let c = 0; c < 3; c++) {
      let min = 255;
      let max = 0;
      for (const bin of box.bins) {
        const value = channel(bin, c);
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (max - min > best.range) best = { axis: c, range: max - min };
    }
    return best;
  };
  while (boxes.length < limit) {
    let chosen = -1;
    let chosenScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].bins.length < 2) continue;
      const score = boxes[i].count * (rangeOf(boxes[i]).range + 1);
      if (score > chosenScore) {
        chosen = i;
        chosenScore = score;
      }
    }
    if (chosen === -1) break;
    const box = boxes[chosen];
    const { axis } = rangeOf(box);
    const sorted = [...box.bins].sort((a, b) => channel(a, axis) - channel(b, axis));
    let running = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      running += counts[sorted[i]];
      cut = i + 1;
      if (running >= box.count / 2) break;
    }
    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    const countOf = (bins: number[]) => bins.reduce((sum, bin) => sum + counts[bin], 0);
    boxes.splice(chosen, 1, { bins: left, count: countOf(left) }, { bins: right, count: countOf(right) });
  }
  const palette = boxes.map((box) => {
    const rgb = [0, 0, 0];
    for (const bin of box.bins) for (let c = 0; c < 3; c++) rgb[c] += sums[bin * 3 + c];
    const [r, g, b] = rgb.map((sum) => Math.round(sum / box.count));
    return (r << 16) | (g << 8) | b;
  });
  const binToIndex = new Uint8Array(32_768);
  for (let bin = 0; bin < 32_768; bin++) {
    // Unused bins map from the bin's center, used ones from their average color.
    const r = counts[bin] > 0 ? channel(bin, 0) : ((bin >> 10) << 3) + 4;
    const g = counts[bin] > 0 ? channel(bin, 1) : (((bin >> 5) & 31) << 3) + 4;
    const b = counts[bin] > 0 ? channel(bin, 2) : ((bin & 31) << 3) + 4;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const color = palette[i];
      const dr = (color >> 16) - r;
      const dg = ((color >> 8) & 255) - g;
      const db = (color & 255) - b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    binToIndex[bin] = best;
  }
  return { palette, binToIndex };
}

// ---------------------------------------------------------------------------------------------
// Transforms

function crop(raster: Raster, box: CropBox): Raster {
  const { width, height, data } = raster;
  if (box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height) {
    throw new ImageError(`crop box ${box.width}x${box.height}+${box.x}+${box.y} lies outside the ${width}x${height} image`);
  }
  const out = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const start = ((box.y + y) * width + box.x) * 4;
    out.set(data.subarray(start, start + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data: out };
}

function rotate(raster: Raster, degrees: number): Raster {
  if (degrees === 0) return raster;
  const { width, height, data } = raster;
  const swap = degrees !== 180;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tx: number;
      let ty: number;
      if (degrees === 90) {
        tx = height - 1 - y;
        ty = x;
      } else if (degrees === 180) {
        tx = width - 1 - x;
        ty = height - 1 - y;
      } else {
        tx = y;
        ty = width - 1 - x;
      }
      const s = (y * width + x) * 4;
      const d = (ty * outWidth + tx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

function flip(raster: Raster, axis: "horizontal" | "vertical"): Raster {
  const { width, height, data } = raster;
  const out = new Uint8Array(data.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    if (axis === "vertical") {
      out.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), (height - 1 - y) * rowBytes);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const s = y * rowBytes + x * 4;
      const d = y * rowBytes + (width - 1 - x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width, height, data: out };
}

type Kernel = { start: Int32Array; size: Int32Array; weights: Float32Array; span: number };

/**
 * Per output pixel, the source pixels and weights of a triangle filter whose support grows with
 * the shrink factor: bilinear when enlarging, area-like averaging when shrinking.
 */
function kernel(source: number, target: number): Kernel {
  const scale = source / target;
  const support = Math.max(1, scale);
  const span = Math.ceil(support) * 2 + 2;
  const start = new Int32Array(target);
  const size = new Int32Array(target);
  const weights = new Float32Array(target * span);
  for (let i = 0; i < target; i++) {
    const center = (i + 0.5) * scale;
    const low = Math.max(0, Math.floor(center - support));
    const high = Math.min(source, Math.ceil(center + support));
    let total = 0;
    for (let j = low; j < high; j++) {
      const weight = Math.max(0, 1 - Math.abs((j + 0.5 - center) / support));
      weights[i * span + j - low] = weight;
      total += weight;
    }
    for (let j = low; j < high; j++) weights[i * span + j - low] /= total;
    start[i] = low;
    size[i] = high - low;
  }
  return { start, size, weights, span };
}

type Axis = { lines: number; length: number; inPixel: number; inLine: number; outPixel: number; outLine: number };

/** Resamples on premultiplied alpha in two separable passes, the cheaper axis first. */
function resize(raster: Raster, width: number, height: number): Raster {
  if (width === raster.width && height === raster.height) return raster;
  const sw = raster.width;
  const sh = raster.height;
  const horizontal = kernel(sw, width);
  const vertical = kernel(sh, height);
  const out = new Uint8Array(width * height * 4);
  if (width * sh <= sw * height) {
    const middle = new Uint16Array(width * sh * 4);
    firstPass(raster.data, middle, horizontal, { lines: sh, length: width, inPixel: 1, inLine: sw, outPixel: 1, outLine: width });
    secondPass(middle, out, vertical, { lines: width, length: height, inPixel: width, inLine: 1, outPixel: width, outLine: 1 });
  } else {
    const middle = new Uint16Array(sw * height * 4);
    firstPass(raster.data, middle, vertical, { lines: sw, length: height, inPixel: sw, inLine: 1, outPixel: sw, outLine: 1 });
    secondPass(middle, out, horizontal, { lines: height, length: width, inPixel: 1, inLine: sw, outPixel: 1, outLine: width });
  }
  return { width, height, data: out };
}

/** RGBA8 to premultiplied RGBA scaled to 0..65535. */
function firstPass(input: Uint8Array, output: Uint16Array, k: Kernel, axis: Axis): void {
  for (let line = 0; line < axis.lines; line++) {
    for (let i = 0; i < axis.length; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const base = i * k.span;
      for (let t = 0; t < k.size[i]; t++) {
        const w = k.weights[base + t];
        const s = (line * axis.inLine + (k.start[i] + t) * axis.inPixel) * 4;
        const wa = w * input[s + 3];
        r += wa * input[s];
        g += wa * input[s + 1];
        b += wa * input[s + 2];
        a += wa;
      }
      const d = (line * axis.outLine + i * axis.outPixel) * 4;
      output[d] = clamp(Math.round((r * 257) / 255), 65_535);
      output[d + 1] = clamp(Math.round((g * 257) / 255), 65_535);
      output[d + 2] = clamp(Math.round((b * 257) / 255), 65_535);
      output[d + 3] = clamp(Math.round(a * 257), 65_535);
    }
  }
}

/** Premultiplied 16-bit back to straight RGBA8. */
function secondPass(input: Uint16Array, output: Uint8Array, k: Kernel, axis: Axis): void {
  for (let line = 0; line < axis.lines; line++) {
    for (let i = 0; i < axis.length; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const base = i * k.span;
      for (let t = 0; t < k.size[i]; t++) {
        const w = k.weights[base + t];
        const s = (line * axis.inLine + (k.start[i] + t) * axis.inPixel) * 4;
        r += w * input[s];
        g += w * input[s + 1];
        b += w * input[s + 2];
        a += w * input[s + 3];
      }
      const d = (line * axis.outLine + i * axis.outPixel) * 4;
      const alpha = clamp(Math.round(a / 257), 255);
      if (alpha === 0) continue; // Fully transparent stays 0,0,0,0.
      output[d] = clamp(Math.round((r / a) * 255), 255);
      output[d + 1] = clamp(Math.round((g / a) * 255), 255);
      output[d + 2] = clamp(Math.round((b / a) * 255), 255);
      output[d + 3] = alpha;
    }
  }
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

// ---------------------------------------------------------------------------------------------
// Helpers

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
