export interface FaceInput { stdoutTTY: boolean; stdinTTY: boolean; columns: number; rows: number; env: Record<string, string | undefined>; platform: string; argv: string[] }

const set = (v: string | undefined) => v !== undefined;

// A display choice only: the flow is identical in both faces.
// - CI: any CI or CONTINUOUS_INTEGRATION variable, whatever its value. Ink itself switches to a CI mode (no redraws,
//   only the last frame at exit) when either is present and not "0"/"false", so the full screen would stay blank;
//   treating every value as CI keeps this check a superset of Ink's.
// - The legacy Windows console (no Windows Terminal session and no modern TERM_PROGRAM such as VS Code) draws box
//   characters poorly, so it gets the plain face.
export function chooseFace(i: FaceInput): "full" | "plain" {
  if (!i.stdoutTTY || !i.stdinTTY) return "plain";
  if (set(i.env.CI) || set(i.env.CONTINUOUS_INTEGRATION)) return "plain";
  if (i.columns < 80 || i.rows < 24) return "plain";
  if (i.env.TERM === "dumb") return "plain";
  if (i.argv.includes("--yes") || i.argv.includes("--plain")) return "plain";
  if (i.platform === "win32" && !i.env.WT_SESSION && !i.env.TERM_PROGRAM) return "plain";
  return "full";
}
