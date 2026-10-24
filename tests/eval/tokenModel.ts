// A script-aware token count for the loopback Anthropic server (tests/eval/anthropicCacheSim.ts),
// closer to a real BPE tokenizer than the default characters / 4: CJK, kana and Hangul cost about
// 1.2 tokens a character, an emoji about 3, other non-ASCII letters about half a token, ASCII a
// quarter; an image costs 1,600 tokens (a full-size image, the most the provider charges) whatever
// its base64 length. Used to measure the life estimator's margin on mixed content (spec §12).
// Not a test file.

const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;
const NON_ASCII = /[^\x00-\x7f]/gu;

export const MODEL_IMAGE_TOKENS = 1_600;

function textTokens(text: string): number {
  const dense = text.match(DENSE)?.length ?? 0;
  const emoji = text.match(EMOJI)?.length ?? 0;
  // Every UTF-16 unit outside ASCII; an emoji is two of them and dense characters one.
  const nonAscii = text.match(NON_ASCII)?.length ?? 0;
  const otherNonAscii = Math.max(0, nonAscii - dense - emoji * 2);
  const ascii = text.length - nonAscii;
  return ascii / 4 + dense * 1.2 + emoji * 3 + otherNonAscii * 0.5;
}

/** The tokens of one wire block (its JSON with every image's data left out, plus each image). */
export function modelTokens(block: unknown): number {
  let images = 0;
  const json = JSON.stringify(block, (key, value: unknown) => {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "image") {
      images += 1;
      return { type: "image" };
    }
    return value;
  });
  return Math.max(1, Math.ceil(textTokens(json ?? "")) + images * MODEL_IMAGE_TOKENS);
}
