import { styleText } from "node:util";

type Style = "accent" | "dim" | "green" | "red" | "yellow" | "bold";
const FORMAT: Record<Exclude<Style, "accent">, Parameters<typeof styleText>[0]> = { dim: "dim", green: "green", red: "red", yellow: "yellow", bold: "bold" };

// The accent is the dashboard's indigo (#6366f1), drawn as 24-bit colour; NO_COLOR or a non-terminal stream gets plain text.
export function color(style: Style, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  if (process.env.NO_COLOR !== undefined || !stream.isTTY) return text;
  if (style === "accent") return `\x1b[38;2;99;102;241m${text}\x1b[39m`;
  // styleText's own colour-support check defaults to process.stdout; forwarding the actual target stream (stderr in
  // a future caller, or a fake stream in a test) keeps that check aligned with the stream we already gated above.
  // The `stream` option landed after styleText itself (Node 20.12); an extra options argument is inert on a Node
  // whose styleText predates it, so this stays safe down to the package's stated engines (">=20"), and our own
  // isTTY/NO_COLOR gate above is what actually decides whether colour is used either way.
  return styleText(FORMAT[style], text, { stream });
}
