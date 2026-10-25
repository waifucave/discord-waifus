// Minimal types for `omggif` (CommonJS, ships none): only what the bash `image` command uses.

declare module "omggif" {
  export type GifFrameInfo = {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number | null;
    palette_size: number | null;
    data_offset: number;
    data_length: number;
    transparent_index: number | null;
    interlaced: boolean;
    delay: number;
    disposal: number;
  };

  export class GifReader {
    constructor(buf: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(frameNum: number): GifFrameInfo;
    decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array): void;
    decodeAndBlitFrameBGRA(frameNum: number, pixels: Uint8Array): void;
  }

  export type GifWriterOptions = { palette?: number[]; loop?: number; background?: number };
  export type GifFrameOptions = { palette?: number[]; delay?: number; disposal?: number; transparent?: number };

  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, options?: GifWriterOptions);
    addFrame(x: number, y: number, width: number, height: number, indexedPixels: Uint8Array, options?: GifFrameOptions): number;
    end(): number;
  }

  const omggif: { GifReader: typeof GifReader; GifWriter: typeof GifWriter };
  export default omggif;
}
