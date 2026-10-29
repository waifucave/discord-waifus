// The scripted addressee detector of a benchmark run. The detector (spec §4.3) is a separate model
// with its own benchmark (`npm run benchmark:decisions`); here it is part of the fixed script, so
// the only model under test is hers. Each scenario message may say what the detector answers for a
// burst ending in it (`detector`); otherwise: a reply to or a mention of another person is `human`,
// a question with nobody named is `anyone`, anything else is `none`. Her own bursts are `none`.

import type { AddresseeDetector, DetectorAnswer, DetectorQuestion } from "../../src/life/detector/decider.js";
import type { DetectorPick, MessageEvent } from "./scenario.js";

export type DetectorDecision = { at: string; messageId: string; label?: string; choice: string; chimeIn?: string };

/** The default pick for a person's message that did not address her directly. */
export function defaultPick(event: Pick<MessageEvent, "text" | "mentions" | "replyTo" | "detector">): DetectorPick {
  if (event.detector) return event.detector;
  const others = event.mentions.filter((mention) => mention !== "her");
  if (others.length > 0) return "human";
  if (event.replyTo && !event.replyTo.startsWith("her:")) return "human";
  if (/\?\s*$/u.test(event.text.trim()) || /\b(anyone|anybody|someone|y'?all|guys)\b/iu.test(event.text)) return "anyone";
  return "none";
}

export class ScriptedDetector {
  readonly decisions: DetectorDecision[] = [];

  constructor(
    private readonly o: {
      /** The scenario message a Discord message id came from (undefined: hers, or unknown). */
      eventOf: (messageId: string) => MessageEvent | undefined;
      now: () => Date;
    }
  ) {}

  async decide(input: { question: DetectorQuestion }): Promise<DetectorAnswer> {
    const state = JSON.parse(input.question.state) as { chronologicalChat?: Array<{ messageId?: string }> };
    const newest = state.chronologicalChat?.[state.chronologicalChat.length - 1]?.messageId ?? "";
    const event = this.o.eventOf(newest);
    const pick: DetectorPick = event ? defaultPick(event) : "none";
    const her = input.question.candidates.length > 0 ? "waifu_0" : "none";
    const choice = pick === "her" ? her : pick === "chime" ? "human" : pick;
    const chimeAsked = input.question.questions["chime_in"] !== undefined;
    const chimeIn = chimeAsked ? (pick === "chime" && her !== "none" ? her : "nobody") : undefined;
    this.decisions.push({ at: this.o.now().toISOString(), messageId: newest, ...(event?.label ? { label: event.label } : {}), choice, ...(chimeIn ? { chimeIn } : {}) });
    return { choice, probabilities: { [choice]: 1 }, ...(chimeIn ? { chimeIn: { choice: chimeIn, probabilities: { [chimeIn]: 1 } } } : {}) };
  }

  close(): void {}

  /** The app's detector type: only `decide` and `close` are used by intake and the cast. */
  asDetector(): AddresseeDetector {
    return this as unknown as AddresseeDetector;
  }
}
