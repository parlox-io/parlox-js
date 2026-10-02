import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { FileChange } from "../../plan.js";
import { renderDiff } from "../../diff.js";
import { summarizeChanges, type ChangeRow } from "../../ui/summary.js";
import { messagesSince, type WizardState } from "../store.js";
import { printable, rowsOf } from "../../ui/text.js";
import { accent, bad, good, muted, warnColor } from "../theme.js";
import { Messages } from "./Messages.js";

const SIGN = { created: "+", edited: "~", deleted: "-" } as const;

/** The files, as the plain face lists them: what happens to each, its path, lines added and removed, what it is for.
 * With a cursor, the chosen row is marked. */
export function ChangeList({ rows, cursor }: { rows: ChangeRow[]; cursor?: number }) {
  const pathWidth = Math.max(4, ...rows.map((r) => r.path.length));
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Text key={i} color={i === cursor ? accent() : undefined}>{cursor === undefined ? "" : i === cursor ? "› " : "  "}{SIGN[r.kind]} {r.path.padEnd(pathWidth)}  <Text color={good()}>+{r.added}</Text> <Text color={bad()}>-{r.removed}</Text>  {r.purpose}</Text>
      ))}
    </Box>
  );
}

type Tone = "add" | "del" | "hunk" | null;
interface Row { text: string; tone: Tone }
const TONE = { add: good, del: bad, hunk: accent } as const;

/** One file's unified diff as screen rows of at most `width` columns: a long line continues on the next rows (a
 * review must show every character of a change), and each row keeps the colour of the line it belongs to. The file
 * header (---, +++) is told apart from the hunks by position, so a content line that starts with "++" is still an
 * added line. */
function diffRows(change: FileChange, width: number): Row[] {
  const text = renderDiff([change]);
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let inHunks = false;
  return lines.flatMap((line) => {
    if (line.startsWith("@@")) inHunks = true;
    const tone: Tone = !inHunks ? null : line.startsWith("@@") ? "hunk" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : null;
    return rowsOf(printable(line), width).map((t) => ({ text: t, tone }));
  });
}

interface View { cursor: number; open: number | null; offset: number }
interface Screen { rows: number[]; height: number; enterOpens: boolean }
const NO_SCREEN: Screen = { rows: [], height: 5, enterOpens: false };

/** One key on the review screen. `rows` is each file's diff length in screen rows; `height` how many fit. In the
 * list, ↑ ↓ choose a file and d opens its diff (so does Enter, unless Enter belongs to the question below); in a
 * diff, ↑ ↓ PgUp PgDn Home End scroll, and d or Esc go back. The cursor never leaves the list, even an empty one. */
export function reviewKey(v: View, input: string, key: Key, s: Screen): View {
  const last = Math.max(0, s.rows.length - 1);
  const cursor = Math.min(Math.max(0, v.cursor), last);
  const d = input === "d" && !key.ctrl && !key.meta;
  if (v.open === null || v.open >= s.rows.length) {
    if (key.upArrow) return { cursor: Math.max(0, cursor - 1), open: null, offset: 0 };
    if (key.downArrow) return { cursor: Math.min(last, cursor + 1), open: null, offset: 0 };
    if (s.rows.length > 0 && (d || (key.return && s.enterOpens))) return { cursor, open: cursor, offset: 0 };
    return v;
  }
  const max = Math.max(0, s.rows[v.open] - s.height);
  const offset = Math.min(v.offset, max);
  if (key.escape || d) return { cursor, open: null, offset: 0 };
  if (key.downArrow) return { ...v, offset: Math.min(max, offset + 1) };
  if (key.upArrow) return { ...v, offset: Math.max(0, offset - 1) };
  if (key.pageDown) return { ...v, offset: Math.min(max, offset + s.height) };
  if (key.pageUp) return { ...v, offset: Math.max(0, offset - s.height) };
  if (key.home) return { ...v, offset: 0 };
  if (key.end) return { ...v, offset: max };
  return v;
}

/** The review: the files to change, each file's diff on d (or Enter), then the Apply question below (drawn by the
 * app). Enter belongs to that question while it is shown; its y, n and ← → do too, so the review uses none of them. */
export function Review({ state, width, rows, current }: { state: WizardState; width: number; rows: number; current?: () => WizardState }) {
  const plan = state.plan;
  const list = useMemo(() => (plan ? summarizeChanges(plan) : []), [plan]);
  const cols = Math.max(20, width - 4);
  const diffs = useMemo(() => (plan ? plan.changes.map((c) => diffRows(c, cols)) : []), [plan, cols]);
  // Around the diff: the app's header (2 rows), the file's header (2) and the question below (3); the other 5 of the
  // 12 are left for a closing line ("Stopping…") and to spare, so the screen never grows past the window.
  const height = Math.max(5, rows - 12);
  // Each key acts on the screen that was drawn when it was pressed (its files, its size, whether the question was
  // showing), and keys that arrive together, before the next redraw, apply in turn: Enter then ↓ opens a diff and
  // scrolls it. The drawn screen is recorded as each render is committed; the reducer applies the keys in order.
  const drawn = useRef<Screen>(NO_SCREEN);
  useLayoutEffect(() => { drawn.current = { rows: diffs.map((r) => r.length), height, enterOpens: !state.prompt }; });
  const [view, dispatch] = useReducer((v: View, k: { input: string; key: Key; screen: Screen }) => reviewKey(v, k.input, k.key, k.screen), { cursor: 0, open: null, offset: 0 });
  // `current` reads the store as the key arrives: after q, the next keys belong to "Quit now?", even when they arrive
  // in the same read, before it is drawn.
  useInput((input, key) => {
    const now = current?.() ?? state;
    if (now.quitAsked || (now.prompt && now.prompt.kind !== "confirm")) return;
    dispatch({ input, key, screen: drawn.current });
  }, { isActive: !state.quitAsked && (!state.prompt || state.prompt.kind === "confirm") });
  const messages = messagesSince(state, "review").slice(-3);
  if (!plan) return messages.length ? <Messages list={messages} marginTop={0} /> : <Text color={muted()}>Preparing the changes…</Text>;

  const open = view.open !== null && view.open < diffs.length ? view.open : null;
  if (open !== null) {
    const all = diffs[open];
    const max = Math.max(0, all.length - height);
    const offset = Math.min(view.offset, max);
    const shown = all.slice(offset, offset + height);
    return (
      <Box flexDirection="column">
        <Text bold>{plan.changes[open].path}</Text>
        {/* Screen rows, not lines of the file: a long line takes several rows. */}
        <Text color={muted()}>rows {offset + 1}–{offset + shown.length} of {all.length} · ↑ ↓ PgUp PgDn Home End scroll · d or Esc back</Text>
        {shown.map((r, i) => (<Text key={i} color={r.tone ? TONE[r.tone]() : undefined}>{r.text}</Text>))}
      </Box>
    );
  }
  const cursor = Math.min(Math.max(0, view.cursor), Math.max(0, list.length - 1));
  const hint = !list.length ? "" : state.prompt ? "↑ ↓ choose · d show diff" : "↑ ↓ choose · Enter or d show diff";
  return (
    <Box flexDirection="column">
      <Text><Text bold>{state.mode === "install" ? "Changes" : "Removals"} in {state.target}: {list.length} file{list.length === 1 ? "" : "s"}</Text>  <Text color={muted()}>{hint}</Text></Text>
      {list.length > 0 && <Box marginTop={1}><ChangeList rows={list} cursor={cursor} /></Box>}
      {plan.install && <Box marginTop={1}><Text color={muted()}>Will run: {plan.install.command} {plan.install.args.join(" ")}</Text></Box>}
      {plan.installs?.length ? <Box marginTop={plan.install ? 0 : 1} flexDirection="column">{plan.installs.map((i, n) => (<Text key={`i${n}`} color={muted()}>Will run in {i.dir}: {i.command} {i.args.join(" ")}</Text>))}</Box> : null}
      {plan.warnings.map((w, i) => (<Text key={`w${i}`} color={warnColor()}>▲ {w}</Text>))}
      {plan.manual.map((m, i) => (<Text key={`m${i}`} color={warnColor()}>▲ {m.file}: {m.reason}{state.mode === "install" ? " (add by hand; shown in the summary)" : ""}</Text>))}
      <Messages list={messages} />
    </Box>
  );
}
