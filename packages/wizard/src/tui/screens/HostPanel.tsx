import { Box, Text } from "ink";
import type { Handoff } from "../../ui/types.js";
import { wrapWords } from "../../ui/text.js";
import { HANDOFF_TITLE, handoffLines } from "../../ui/handoff.js";
import { muted } from "../theme.js";

const NOTE = "Links are printed again when you close the wizard.";

/** The panel's rows at `width` columns (its border and padding take 4): the title, then each hand-off line wrapped. A
 * long link is cut across rows, as the screen would cut it; the note below says where it can be copied whole. */
function panelRows(handoff: Handoff, width: number): string[] {
  return [HANDOFF_TITLE, ...handoffLines(handoff).flatMap((l) => wrapWords(l, Math.max(10, width - 4)))];
}

/** Rows the panel takes at `width` columns, with its border and the note below it. */
export function hostPanelHeight(handoff: Handoff, width: number): number {
  return panelRows(handoff, width).length + 2 + wrapWords(NOTE, width).length;
}

/** What is left to set on the host, in the plain face's words (the same lines are printed after the wizard closes).
 * handoffLines() scrubs every line, so the panel draws no key whatever hand-off it is given. Given its `width`, the
 * panel is drawn row by row and takes exactly hostPanelHeight() rows. */
export function HostPanel({ handoff, width }: { handoff: Handoff; width?: number }) {
  const rows = width ? panelRows(handoff, width) : [HANDOFF_TITLE, ...handoffLines(handoff)];
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={muted()} paddingX={1}>
        {rows.map((l, i) => (<Text key={i} bold={i === 0}>{l}</Text>))}
      </Box>
      {/* Ink breaks a line longer than the pane with real line breaks, and a link broken that way cannot be copied. */}
      {(width ? wrapWords(NOTE, width) : [NOTE]).map((l, i) => (<Text key={i} color={muted()}>{l}</Text>))}
    </Box>
  );
}
