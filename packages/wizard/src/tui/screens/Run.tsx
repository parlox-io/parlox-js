import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import type { Status, TaskId } from "../../ui/types.js";
import { summarizeChanges } from "../../ui/summary.js";
import { rowsOf, widthOf, wrapWords } from "../../ui/text.js";
import { messagesSince, type WizardState } from "../store.js";
import { promptRows } from "../Prompt.js";
import { accent, bad, good, muted, STATUS_MARK } from "../theme.js";
import { ChangeList } from "./Review.js";
import { HostPanel, hostPanelHeight } from "./HostPanel.js";
import { fitMessages, Messages } from "./Messages.js";

const TABS = ["Status", "Changes", "Logs"] as const;
/** From this width the left pane and the task list stand side by side; below it they are stacked. */
export const SPLIT_WIDTH = 100;
const TASKS_WIDTH = 44;
const LOG_ROWS = 15;
// Rows around the run view: the app's header (2 rows) and one row kept free, so the frame stays shorter than the
// window (a frame as tall as the window makes Ink clear the screen and draw it whole on every change, and a taller
// one scrolls its top away). The question below takes at least QUESTION_ROWS, kept even while none is showing so the
// screen does not jump when one appears. The tab bar takes 2.
const HEADER_ROWS = 2, SPARE_ROWS = 1, QUESTION_ROWS = 3, TAB_BAR_ROWS = 2;
// An uninstall only removes the packages: it has no host step and no local check.
const TASKS: Record<WizardState["mode"], Array<[TaskId, string]>> = {
  install: [["install", "Install packages"], ["host", "Connect your host"], ["check", "Check locally"]],
  uninstall: [["install", "Remove packages"]],
};

/** The left pane: a node, or a function given the rows the pane may use at this window size, which returns what
 * fits (the slides only when they fit, say). */
export type LeftPane = ReactNode | ((rows: number) => ReactNode);

/** Rows the run view's own content may use in a window of `rows` rows at `width` columns, around it the app's
 * header, the question (or the room kept for one), "Quit now?", the closing line and the spare row. */
function bodyRows(state: WizardState, width: number, rows: number): number {
  const question = Math.max(QUESTION_ROWS, state.prompt ? promptRows(state.prompt, width - 2) : 0);
  return rows - HEADER_ROWS - SPARE_ROWS - question - (state.quitAsked ? 1 : 0) - (state.closing ? 1 : 0) - TAB_BAR_ROWS;
}

/** The run: install, host, check. Three tabs (Tab and Shift-Tab switch):
 * - Status: the left pane (the slides) beside the task list (stacked below 100 columns), then the latest messages;
 *   once there is a host hand-off, the hand-off in the slides' place (it is what is left to do) with the tasks on one
 *   line under it;
 * - Changes: the files changed;
 * - Logs: the package manager's latest output.
 * Given the window's `rows`, everything is sized to fit it: the messages get the rows left after the panel or the
 * task list (the newest warnings first; the rest are counted, and printed when the wizard closes), and the left pane
 * gets what is left after them. `current` reads the store as a key arrives: after q, the next keys belong to
 * "Quit now?" even before it is drawn. */
export function Run({ state, width, rows = Infinity, left, current }: { state: WizardState; width: number; rows?: number; left: LeftPane; current?: () => WizardState }) {
  const [tab, setTab] = useState(0);
  // Tab is not taken while an answer is being typed or "Quit now?" is showing: those keys belong to the question.
  useInput((_input, key) => {
    const now = current?.() ?? state;
    if (now.quitAsked || now.prompt?.kind === "text") return;
    if (key.tab) setTab((t) => (t + (key.shift ? TABS.length - 1 : 1)) % TABS.length);
  }, { isActive: !state.quitAsked && state.prompt?.kind !== "text" });
  const wide = width >= SPLIT_WIDTH;
  const inner = width - 2; // the app's side margins
  const body = bodyRows(state, width, rows);
  const tone = (st: Status) => (st === "active" ? accent() : st === "done" ? good() : st === "failed" ? bad() : undefined);
  const messages = messagesSince(state, "review");
  let content: ReactNode;
  if (tab === 0 && state.handoff) {
    // The hand-off across the whole width, so its links fit on their lines where the window allows. Under it, the
    // tasks on one line, then the messages that fit; with no room for both, the count of warnings left out wins
    // over the task line (the question below says where the run is).
    const panel = hostPanelHeight(state.handoff, inner);
    const items = TASKS[state.mode].map(([id, title]) => ({ id, text: `${STATUS_MARK[state.tasks[id].status]} ${title}   `, status: state.tasks[id].status }));
    const taskRows = packedRows(["Tasks  ", ...items.map((i) => i.text)], inner);
    let fit = fitMessages(messages, body - panel - taskRows, inner);
    let showTasks = true;
    if (fit.rows === 0 && messages.some((m) => m.kind === "warn")) {
      const without = fitMessages(messages, body - panel, inner);
      if (without.rows > 0) { fit = without; showTasks = false; }
    }
    content = (
      <Box flexDirection="column">
        <HostPanel handoff={state.handoff} width={inner} />
        {showTasks && (
          <Box flexWrap="wrap">
            <Text bold>Tasks  </Text>
            {items.map((i) => (<Text key={i.id} color={tone(i.status)}>{i.text}</Text>))}
          </Box>
        )}
        <Messages list={fit.shown} width={inner} hiddenWarnings={fit.hiddenWarnings} marginTop={0} />
      </Box>
    );
  } else if (tab === 0) {
    const boxInner = (wide ? TASKS_WIDTH : inner) - 4;
    const taskLines = TASKS[state.mode].map(([id, title]) => {
      const t = state.tasks[id];
      // Wrapped 2 columns short, so the rows after the first fit with their indent.
      return { id, status: t.status, rows: wrapWords(`${STATUS_MARK[t.status]} ${title}${t.detail && t.status !== "active" ? `: ${t.detail}` : ""}`, boxInner - 2) };
    });
    const tasksHeight = 3 + taskLines.reduce((n, t) => n + t.rows.length, 0);
    // The messages, with the blank row above them, get what the task list leaves; the left pane gets the rest.
    const fit = fitMessages(messages, body - tasksHeight - 1, inner);
    const messageBlock = fit.rows ? 1 + fit.rows : 0;
    const leftRows = Math.max(0, wide ? body - messageBlock : body - tasksHeight - messageBlock);
    const leftNode = typeof left === "function" ? left(leftRows) : left;
    content = (
      <Box flexDirection="column">
        <Box flexDirection={wide ? "row" : "column"}>
          {leftNode !== null && leftNode !== undefined && leftNode !== false && (
            <Box flexDirection="column" flexGrow={1} flexShrink={1} marginRight={wide ? 1 : 0}>{leftNode}</Box>
          )}
          <Box flexDirection="column" borderStyle="round" borderColor={muted()} paddingX={1} flexShrink={0} {...(wide ? { width: TASKS_WIDTH } : {})}>
            <Text bold>Tasks</Text>
            {taskLines.flatMap((t) => t.rows.map((r, j) => (<Text key={`${t.id}.${j}`} color={tone(t.status)}>{j ? `  ${r}` : r}</Text>)))}
          </Box>
        </Box>
        <Messages list={fit.shown} width={inner} hiddenWarnings={fit.hiddenWarnings} />
      </Box>
    );
  } else if (tab === 1) {
    const list = state.plan ? summarizeChanges(state.plan) : [];
    const room = Math.max(1, body);
    const shown = list.length > room ? list.slice(0, room - 1) : list;
    content = list.length
      ? (<Box flexDirection="column"><ChangeList rows={shown} />{shown.length < list.length && <Text color={muted()}>{list.length - shown.length} more files</Text>}</Box>)
      : <Text color={muted()}>No files changed.</Text>;
  } else {
    // The latest rows of output, each line wrapped rather than cut (an error is often on the longest line). The store
    // has made them printable.
    const count = Math.max(1, Math.min(LOG_ROWS, body));
    const logRows = state.logs.slice(-count).flatMap((l) => rowsOf(l, Math.max(20, inner))).slice(-count);
    content = logRows.length ? <Box flexDirection="column">{logRows.map((r, i) => (<Text key={i} color={muted()}>{r}</Text>))}</Box> : <Text color={muted()}>No output yet.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        {TABS.map((t, i) => (<Text key={t} color={i === tab ? accent() : muted()}>{i === tab ? `[${t}]` : ` ${t} `}   </Text>))}
        <Text color={muted()}>Tab switches</Text>
      </Box>
      {content}
    </Box>
  );
}

/** Rows a line of items takes when they wrap as whole items (a flex row with wrapping), at `width` columns. */
function packedRows(items: string[], width: number): number {
  let rows = 1, used = 0;
  for (const item of items) {
    const w = widthOf(item);
    if (used && used + w > width) { rows++; used = 0; }
    used += w;
  }
  return rows;
}
