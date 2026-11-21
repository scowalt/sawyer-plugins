import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  preferencesPatchSchema,
  preferencesSchema,
  readStoredPreferences,
} from "./preferences";

describe("preferencesPatchSchema", () => {
  it("carries only the fields it was given, so a save cannot reset the others", () => {
    expect(preferencesPatchSchema.parse({ holdSend: false })).toEqual({ holdSend: false });
    expect(preferencesPatchSchema.parse({ machineInstructions: "Prefer the Mac." })).toEqual({
      machineInstructions: "Prefer the Mac.",
    });
    expect(preferencesPatchSchema.parse({})).toEqual({});
  });

  it("merges over what is stored without touching the rest", () => {
    const stored = { ...DEFAULT_PREFERENCES, machineInstructions: "Prefer the Mac.", pace: "pause" as const };
    const patch = preferencesPatchSchema.parse({ holdSend: false });
    expect(preferencesSchema.parse({ ...stored, ...patch })).toEqual({ ...stored, holdSend: false });
  });

  it("refuses a field it does not know and a value out of range", () => {
    expect(preferencesPatchSchema.safeParse({ nonsense: true }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ pace: "never" }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ machineInstructions: "x".repeat(4_001) }).success).toBe(false);
    // The model and effort settings are gone, so a save may not send them.
    expect(preferencesPatchSchema.safeParse({ modelInstructions: "Use Fable." }).success).toBe(false);
  });
});

describe("readStoredPreferences", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(readStoredPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(readStoredPreferences("nonsense")).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps what is stored and fills in a preference added since", () => {
    const { pace: _pace, ...older } = { ...DEFAULT_PREFERENCES, machineInstructions: "Prefer the Mac." };
    expect(readStoredPreferences({ ...older, maySet: { project: false } })).toEqual({
      ...DEFAULT_PREFERENCES,
      machineInstructions: "Prefer the Mac.",
      maySet: { ...DEFAULT_PREFERENCES.maySet, project: false },
    });
  });

  it("loads preferences stored before the model and effort were removed, dropping those keys", () => {
    const stored = {
      ...DEFAULT_PREFERENCES,
      projectInstructions: "bb is the main repo.",
      holdSend: false,
      modelInstructions: "Use Fable for UI design.",
      maySet: { project: false, placement: true, model: true, effort: true },
    };
    const read = readStoredPreferences(stored);
    expect(read).toEqual({
      ...DEFAULT_PREFERENCES,
      projectInstructions: "bb is the main repo.",
      holdSend: false,
      maySet: { project: false, placement: true },
    });
    expect(read).not.toHaveProperty("modelInstructions");
    expect(preferencesSchema.safeParse(read).success).toBe(true);
  });
});
