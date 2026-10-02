// The dashboard's palette: accent indigo #6366f1, slate greys. NO_COLOR removes colour everywhere.
const noColor = () => process.env.NO_COLOR !== undefined;
export const accent = () => (noColor() ? undefined : "#6366f1");
export const muted = () => (noColor() ? undefined : "#64748b");
export const good = () => (noColor() ? undefined : "green");
export const bad = () => (noColor() ? undefined : "red");
export const warnColor = () => (noColor() ? undefined : "yellow");
export const STATUS_MARK = { pending: "○", active: "◐", done: "✔", failed: "✖", skipped: "–" } as const;
