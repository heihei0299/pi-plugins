export const PANEL_PRESETS = ["code-review", "research", "security-review", "custom"] as const;

export type PanelPreset = (typeof PANEL_PRESETS)[number];
