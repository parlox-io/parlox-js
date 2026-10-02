import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Prompt as PromptT } from "./store.js";
import { accent, muted } from "./theme.js";
import { wrapWords } from "../ui/text.js";

/** Keys pressed this soon after a question appears (or starts taking keys) are ignored: a second Enter meant for the
 * question before (a double tap) must not answer this one unseen. Browsers delay the buttons of permission dialogs
 * for the same reason. */
export const INPUT_DELAY_MS = 250;

// The line under a multi-select's options, and what it adds while nothing is selected (Enter then does nothing).
const MULTI_KEYS = "  space changes · Enter confirms";
const MULTI_EMPTY = " · select at least one";

/** Rows a question takes at `width` columns: the blank row above it, its message and its answers, each wrapped. */
export function promptRows(prompt: PromptT, width: number): number {
  const rows = (text: string) => text.split("\n").reduce((n, line) => n + wrapWords(line, width).length, 0);
  const answers = prompt.kind === "select" ? prompt.options.reduce((n, o) => n + rows(`  ○ ${o.label}`), 0)
    : prompt.kind === "multiselect" ? prompt.options.reduce((n, o) => n + rows(`› ◼ ${o.label}`), 0) + rows(MULTI_KEYS + MULTI_EMPTY)
    : 1;
  return 1 + rows(`◆ ${prompt.message}`) + answers;
}

/** One question at a time. `active` is false while "Quit now?" is showing, so a y or n meant for that question never
 * also answers this one. Every answer carries this question's id (the store drops an answer to an earlier one). */
export function Prompt({ prompt, onAnswer, active = true }: { prompt: PromptT; onAnswer: (v: unknown, id: number) => void; active?: boolean }) {
  const [index, drawIndex] = useState(0);
  const [value, drawValue] = useState("");
  const [picked, drawPicked] = useState<boolean[]>(() => (prompt.kind === "multiselect" ? prompt.options.map(() => true) : []));
  // Several keys can arrive before the question is drawn again (typed together, or while the machine was busy), and
  // until then the handler below still holds the values it was drawn with. The keys are applied to these instead, so
  // each sees the ones before it: "x" then Enter answers "x", ↓ then Enter the second option.
  const latest = useRef({ index: 0, value: "", picked: prompt.kind === "multiselect" ? prompt.options.map(() => true) : ([] as boolean[]) });
  const setIndex = (f: (i: number) => number) => { latest.current.index = f(latest.current.index); drawIndex(latest.current.index); };
  const setValue = (f: (v: string) => string) => { latest.current.value = f(latest.current.value); drawValue(latest.current.value); };
  const toggle = (i: number) => { latest.current.picked = latest.current.picked.map((p, j) => (j === i ? !p : p)); drawPicked(latest.current.picked); };
  const shownAt = useRef(Date.now());
  // The guard counts from when the question can take keys: one drawn behind "Quit now?" starts taking them only when
  // that question is dismissed, and an Enter typed just after the n must not answer it.
  useEffect(() => { if (active) shownAt.current = Date.now(); }, [active]);
  const answer = (v: unknown) => onAnswer(v, prompt.id);
  useInput((input, key) => {
    if (Date.now() - shownAt.current < INPUT_DELAY_MS) return;
    if (prompt.kind === "select") {
      if (key.upArrow) setIndex((i) => (i - 1 + prompt.options.length) % prompt.options.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % prompt.options.length);
      else if (key.return) answer(prompt.options[latest.current.index].value);
    } else if (prompt.kind === "multiselect") {
      if (key.upArrow) setIndex((i) => (i - 1 + prompt.options.length) % prompt.options.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % prompt.options.length);
      else if (input === " ") toggle(latest.current.index);
      else if (key.return) {
        // At least one must stay selected: with none, Enter does nothing (the line under the options says why).
        const values = prompt.options.filter((_, i) => latest.current.picked[i]).map((o) => o.value);
        if (values.length) answer(values);
      }
    } else if (prompt.kind === "confirm") {
      // Left/right only: up/down belong to the screen behind the question (the review screen's file list).
      if (key.leftArrow || key.rightArrow) setIndex((i) => 1 - i);
      else if (input === "y") answer(true);
      else if (input === "n") answer(false);
      else if (key.return) answer(latest.current.index === 0);
    } else {
      // The placeholder is an example, not an answer: Enter on an empty field answers "" (as in the plain face).
      if (key.return) answer(latest.current.value);
      else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) setValue((v) => v + input);
    }
  }, { isActive: active });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={accent()} bold>◆ {prompt.message}</Text>
      {prompt.kind === "select" && prompt.options.map((o, i) => (
        <Text key={i} color={i === index ? accent() : undefined}>{i === index ? "  ● " : "  ○ "}{o.label}</Text>
      ))}
      {prompt.kind === "multiselect" && prompt.options.map((o, i) => (
        <Text key={i} color={i === index ? accent() : undefined}>{i === index ? "› " : "  "}{picked[i] ? "◼ " : "◻ "}{o.label}</Text>
      ))}
      {prompt.kind === "multiselect" && <Text color={muted()}>{MULTI_KEYS}{picked.some(Boolean) ? "" : MULTI_EMPTY}</Text>}
      {prompt.kind === "confirm" && (
        <Text>  <Text color={index === 0 ? accent() : undefined}>{index === 0 ? "● Yes" : "○ Yes"}</Text>  <Text color={index === 1 ? accent() : undefined}>{index === 1 ? "● No" : "○ No"}</Text></Text>
      )}
      {prompt.kind === "text" && (
        <Text>  {value ? <Text>{value}</Text> : <Text color={muted()}>{prompt.placeholder ?? ""}</Text>}<Text color={accent()}>▌</Text></Text>
      )}
    </Box>
  );
}
