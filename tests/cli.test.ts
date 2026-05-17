import { describe, expect, it } from "vitest";
import { flagBoolean, flagNumber, flagString, parseCliArgs } from "../src/cli/parser.js";

describe("CLI parser", () => {
  it("parses commands, flags, and data-root aliases", () => {
    const parsed = parseCliArgs(["start", "--port", "4777", "--data-root=/tmp/waifus", "--force"]);
    expect(parsed.command).toBe("start");
    expect(flagNumber(parsed.flags, "port")).toBe(4777);
    expect(flagString(parsed.flags, "dataRoot")).toBe("/tmp/waifus");
    expect(flagBoolean(parsed.flags, "force")).toBe(true);
  });

  it("defaults unknown commands to help", () => {
    expect(parseCliArgs(["unknown"]).command).toBe("help");
  });
});
