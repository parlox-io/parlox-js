import { Box, Text } from "ink";
import { wrapWords } from "../../ui/text.js";
import type { WizardState } from "../store.js";
import { muted, warnColor } from "../theme.js";

type Message = WizardState["messages"][number];

/** A message's rows at `width` columns: ▲ for a warning, ● for information (as the plain face marks them), its
 * lines wrapped under the text. */
export function messageRows(m: Message, width: number): string[] {
  const inner = Math.max(10, width - 2);
  return m.text.split("\n").flatMap((line) => wrapWords(line, inner)).map((row, i) => `${i === 0 ? (m.kind === "warn" ? "▲ " : "● ") : "  "}${row}`);
}

/** The messages that fit in `space` rows at `width` columns. Warnings come first, the newest first, then information,
 * and at most `cap` in all; they are drawn in the order they came. When warnings are left out, one row says how many
 * (every warning is printed when the wizard closes); left-out information is not counted, as it is not printed. */
export function fitMessages(list: Message[], space: number, width: number, cap = 3): { shown: Message[]; hiddenWarnings: number; rows: number } {
  const ranked = list.map((m, i) => ({ m, i })).reverse().sort((a, b) => (a.m.kind === b.m.kind ? 0 : a.m.kind === "warn" ? -1 : 1));
  const warnings = list.filter((m) => m.kind === "warn").length;
  for (let k = Math.min(cap, ranked.length); k >= 0; k--) {
    const taken = ranked.slice(0, k);
    const hiddenWarnings = warnings - taken.filter((t) => t.m.kind === "warn").length;
    const rows = taken.reduce((n, t) => n + messageRows(t.m, width).length, 0) + (hiddenWarnings ? 1 : 0);
    if (rows <= space) return { shown: taken.sort((a, b) => a.i - b.i).map((t) => t.m), hiddenWarnings, rows };
  }
  // Not even the count fits.
  return { shown: [], hiddenWarnings: 0, rows: 0 };
}

/** The newest messages that fit in `space` rows at `width` columns, as rows drawn in the order the messages came:
 * whole messages, the newest first; the first that does not fit whole shows its first rows, and nothing older is shown.
 * When warning lines are left out, one row counts them (every warning is printed when the wizard closes); information
 * left out is not counted, as it is not printed. For the step screens, where one message can run long (the
 * uncommitted files, one per line) and its first rows say what it is about. */
export function fitRows(list: Message[], space: number, width: number): { rows: Array<{ text: string; kind: Message["kind"] }>; hiddenLines: number } {
  const take = (room: number) => {
    const rows: Array<{ text: string; kind: Message["kind"] }> = [];
    let hiddenLines = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i], all = messageRows(m, width);
      const fit = Math.max(0, Math.min(all.length, room));
      rows.unshift(...all.slice(0, fit).map((text) => ({ text, kind: m.kind })));
      room -= fit;
      if (m.kind === "warn") hiddenLines += all.length - fit;
    }
    return { rows, hiddenLines };
  };
  if (space < 1) return { rows: [], hiddenLines: 0 };
  const all = take(space);
  // Anything counted takes a row of its own.
  return all.hiddenLines ? take(space - 1) : all;
}

export const moreLines = (n: number) => `${n} more line${n === 1 ? " is" : "s are"} printed when you close the wizard.`;

export const moreWarnings = (n: number) => `${n} more warning${n === 1 ? " is" : "s are"} printed when you close the wizard.`;

/** Messages as the plain face marks them: ▲ for a warning, ● for information. Given a `width`, each is drawn row by row
 * (so its height is known), and `hiddenWarnings` adds the row that counts the warnings left out. */
export function Messages({ list, marginTop = 1, width, hiddenWarnings = 0 }: { list: Message[]; marginTop?: number; width?: number; hiddenWarnings?: number }) {
  if (!list.length && !hiddenWarnings) return null;
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {list.map((m, i) => {
        const color = m.kind === "warn" ? warnColor() : muted();
        return width
          ? messageRows(m, width).map((row, j) => (<Text key={`${i}.${j}`} color={color}>{row}</Text>))
          : (<Text key={i} color={color}>{m.kind === "warn" ? "▲ " : "● "}{m.text}</Text>);
      })}
      {hiddenWarnings > 0 && <Text color={warnColor()}>{moreWarnings(hiddenWarnings)}</Text>}
    </Box>
  );
}
