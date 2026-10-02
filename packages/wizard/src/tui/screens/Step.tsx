import { Box, Text } from "ink";
import { messagesSince, type WizardState } from "../store.js";
import { STEP_TITLES } from "../../ui/plain.js";
import { wrapWords } from "../../ui/text.js";
import { promptRows } from "../Prompt.js";
import { good, muted, warnColor } from "../theme.js";
import { fitRows, moreLines } from "./Messages.js";

// Rows around the step's own content, as in the run view: the app's header (2 rows) and one row kept free, so the
// frame stays shorter than the window (a frame as tall as the window makes Ink redraw it whole on every change, and a
// taller one scrolls its top away).
const HEADER_ROWS = 2, SPARE_ROWS = 1;

const factLine = (f: { label: string; value: string }) => `✔ ${f.label.padEnd(8)} ${f.value}`;

/** Detect, site, and any step without its own screen: the facts found so far and this step's latest messages. Given
 * the window's `rows`, the messages get the rows left after the title, the facts and the question below (the newest
 * first; a long one shows its first rows), and one row counts the lines left out, which are printed when the wizard
 * closes. */
export function Step({ state, width = 100, rows = Infinity }: { state: WizardState; width?: number; rows?: number }) {
  const title = state.step === "welcome" ? "" : STEP_TITLES[state.step];
  const inner = width - 2; // the app's side margins
  const factRows = state.facts.reduce((n, f) => n + wrapWords(factLine(f), inner).length, 0);
  const question = state.prompt ? promptRows(state.prompt, inner) : 0;
  // The title, the facts with the blank row above them, the question, "Quit now?", the closing line, and the blank row
  // above the messages.
  const room = rows - HEADER_ROWS - SPARE_ROWS - 1 - (1 + factRows) - question - (state.quitAsked ? 1 : 0) - (state.closing ? 1 : 0) - 1;
  const fit = fitRows(messagesSince(state, state.step), room, inner);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.facts.map((f, i) => (<Text key={i}><Text color={good()}>✔ </Text><Text bold>{f.label.padEnd(8)}</Text> {f.value}</Text>))}
      </Box>
      {(fit.rows.length > 0 || fit.hiddenLines > 0) && (
        <Box flexDirection="column" marginTop={1}>
          {fit.rows.map((r, i) => (<Text key={i} color={r.kind === "warn" ? warnColor() : muted()}>{r.text}</Text>))}
          {fit.hiddenLines > 0 && <Text color={warnColor()}>{moreLines(fit.hiddenLines)}</Text>}
        </Box>
      )}
    </Box>
  );
}
