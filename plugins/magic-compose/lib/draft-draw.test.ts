import { describe, expect, it } from "vitest";
import { createDraftDraw } from "./draft-draw";

describe("createDraftDraw", () => {
  it("gives one number to every text of a draft, and a new one after the composer empties", () => {
    const numbers = [0.11, 0.22, 0.33];
    const draw = createDraftDraw(() => numbers.shift() ?? 0.99);
    const first = draw.forText("fix");
    expect(draw.forText("fix the sidebar")).toBe(first);
    expect(draw.forText("fix the sidebar flicker")).toBe(first);
    expect(first).toBe(0.11);

    draw.forText("   ");
    const second = draw.forText("write a release note");
    expect(second).not.toBe(first);
    expect(draw.forText("write a release note for 0.2")).toBe(second);
  });
});
