// Unit system. Internally the packer works in a single canonical unit per
// system (feet for imperial, mm for metric). The UI lets the user type in
// friendly units and converts here.

export type System = "imperial" | "metric";

export interface UnitPreset {
  system: System;
  label: string; // e.g. "ft" or "mm"
  // default OSB sheet in the canonical unit for this system
  defaultSheet: { w: number; h: number };
}

export const PRESETS: Record<System, UnitPreset> = {
  imperial: {
    system: "imperial",
    label: "ft",
    defaultSheet: { w: 4, h: 8 }, // 4x8 ft
  },
  metric: {
    system: "metric",
    label: "mm",
    defaultSheet: { w: 1220, h: 2440 }, // standard metric OSB
  },
};

/** Format an area for display with the right unit suffix. */
export function formatArea(area: number, system: System): string {
  if (system === "imperial") {
    return `${area.toFixed(1)} ft²`;
  }
  // mm² is unwieldy; show m².
  const m2 = area / 1_000_000;
  return `${m2.toFixed(2)} m²`;
}

export function formatLength(len: number, system: System): string {
  return system === "imperial"
    ? `${len.toFixed(2)} ft`
    : `${len.toFixed(0)} mm`;
}
