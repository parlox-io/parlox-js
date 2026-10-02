import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { accent, muted } from "./theme.js";

// Illustrations of what the dashboard shows, following parlox.io's journey (Observe, Diagnose, Fix, Attribute).
// They contain no figures (a merchant has run nothing yet, so there is nothing to count) and no agent is named twice
// within a frame (that would imply one visits more than another): only measured rates ever appear as numbers, and
// only in the dashboard itself. Each is marked "illustration" on screen.
const VISITS: Array<[string, string]> = [
  ["ChatGPT", "/products/cedar-sauna"],
  ["Claude", "/shipping"],
  ["Gemini", "/checkout"],
  ["Perplexity", "/warranty"],
  ["Copilot", "/returns"],
];
const reveal = (text: string, frame: number, start: number) => text.slice(0, Math.max(0, (frame - start) * 4));
// A frame far past the end of every slide's reveal: what each slide looks like once it has settled.
const FINAL_FRAME = 1000;

export const SLIDES: Array<{ title: string; render(frame: number): string[] }> = [
  {
    title: "Observe · It finds you",
    // Not "right now" or "your store": the wizard has read nothing from the merchant's store; this is what the
    // dashboard will show once it has.
    render: (f) => ["Which agents visit, and what they read", "", ...VISITS.slice(0, Math.min(VISITS.length, Math.floor(f / 3) + 1)).map(([a, p]) => `  ● ${a.padEnd(11)} reading ${p}`)],
  },
  {
    title: "Diagnose · It gets stuck",
    render: (f) => {
      const path = ["search", "product page", "delivery date"];
      const shown = path.slice(0, Math.min(path.length, Math.floor(f / 3) + 1));
      return ["A shopping agent looking for a sauna", "", `  ${shown.map((s, i) => (i === path.length - 1 ? `${s} ✗` : s)).join("  ──▶  ")}`, "", shown.length === path.length ? "  stuck here: the date picker needs a mouse" : ""];
    },
  },
  {
    title: "Fix · It gets a straight answer",
    // The value column is as wide as the longest value plus a space, so the final picture shows every word whole.
    render: (f) => ["What the agent reads instead", "", "  ┌ offer ─────────────────────────────┐",
      `  │ availability  ${reveal("in stock", f, 1).padEnd(21)}│`, `  │ price         ${reveal("from your catalogue", f, 3).padEnd(21)}│`,
      `  │ delivery to   ${reveal("the buyer's address", f, 5).padEnd(21)}│`, `  │ arrives by    ${reveal("a date, not a picker", f, 7).padEnd(21)}│`,
      "  └────────────────────────────────────┘"],
  },
  {
    title: "Attribute · It buys, and you know",
    render: (f) => {
      const steps = ["agent visit", "cart", "checkout", "order"];
      const shown = steps.slice(0, Math.min(steps.length, Math.floor(f / 3) + 1));
      return ["The same journey, completed", "", `  ${shown.join("  ──▶  ")}`, "", shown.length === steps.length ? "  purchase ✓ confirmed by your server, linked back to the agent" : ""];
    },
  },
];

// The bordered box's own rows, fixed regardless of content: border (2) + the title row (1) + the margin above the
// body (1) + the body (minHeight 8; every slide above renders 8 lines or fewer, so the box never grows past this) +
// the dots row (1). Guarded by a test that measures the rendered frame, so a slide that grew past 8 lines would fail
// it rather than silently push the box taller than this constant says.
export const SLIDES_HEIGHT = 13;

/** The illustrated slides shown while a run is in progress (and, room allowing, under the welcome screen): what the
 * dashboard will show once agents have actually visited. `intervalMs` is how long each slide stays up before the
 * next one takes over on its own; `animationMs` is the pace of each slide's own reveal. ← → flip slides by hand and
 * reset that timer, so the wizard does not immediately flip away from a slide someone just chose. Arrow keys are
 * ignored while `active` is false: the caller passes this while a question is on screen (or "Quit now?"), so ← → go
 * to the question instead. */
export function Slides({ intervalMs = 6000, animationMs = 300, active = true }: { intervalMs?: number; animationMs?: number; active?: boolean }) {
  const [index, setIndex] = useState(0);
  const [frame, setFrame] = useState(0);
  useEffect(() => { const t = setInterval(() => { setIndex((i) => (i + 1) % SLIDES.length); setFrame(0); }, intervalMs); return () => clearInterval(t); }, [intervalMs, index]);
  // One step of the reveal at a time, until the slide shows its final picture; then nothing is scheduled, rather than
  // redrawing a settled illustration every animationMs for as long as the run takes. Compared with the final picture,
  // not with the previous frame: some frames draw the same picture as the one before (the list grows every third).
  useEffect(() => {
    const slide = SLIDES[index];
    if (slide.render(frame).join("\n") === slide.render(FINAL_FRAME).join("\n")) return;
    const t = setTimeout(() => setFrame((f) => f + 1), animationMs);
    return () => clearTimeout(t);
  }, [animationMs, index, frame]);
  useInput((_input, key) => {
    if (key.rightArrow) { setIndex((i) => (i + 1) % SLIDES.length); setFrame(0); }
    else if (key.leftArrow) { setIndex((i) => (i - 1 + SLIDES.length) % SLIDES.length); setFrame(0); }
  }, { isActive: active });
  const slide = SLIDES[index];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={muted()} paddingX={1}>
      <Box justifyContent="space-between"><Text color={accent()} bold>{slide.title}</Text><Text color={muted()}>illustration</Text></Box>
      <Box flexDirection="column" marginTop={1} minHeight={8}>{slide.render(frame).map((l, i) => (<Text key={i}>{l}</Text>))}</Box>
      <Text color={muted()}>{SLIDES.map((_, i) => (i === index ? "●" : "○")).join(" ")}   ← → flip</Text>
    </Box>
  );
}
