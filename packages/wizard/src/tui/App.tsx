import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { StepId } from "../ui/types.js";
import { STEP_TITLES } from "../ui/plain.js";
import type { WizardState, WizardStore } from "./store.js";
import { Prompt } from "./Prompt.js";
import { Welcome, welcomeRows } from "./screens/Welcome.js";
import { Step } from "./screens/Step.js";
import { Done } from "./screens/Done.js";
import { Signin } from "./screens/Signin.js";
import { Review } from "./screens/Review.js";
import { Run } from "./screens/Run.js";
import { Slides, SLIDES_HEIGHT } from "./Slides.js";
import { accent, good, muted, STATUS_MARK } from "./theme.js";

// The header's own rows: the wordmark and tagline on one row, plus the margin below them.
const HEADER_ROWS = 2;

export function Header() {
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text color={accent()} bold>◆◆◆  P A R L O X</Text>
      <Text color={muted()}>Your next customer is software.</Text>
    </Box>
  );
}

/** The window's size, kept current: Ink lays the screen out again when the window is resized, but a screen that
 * chooses its layout from the width (the run view stacks its panes below 100 columns) has to be drawn again too. */
function useWindowSize() {
  const { stdout } = useStdout();
  const read = () => ({ width: stdout?.columns || 100, rows: stdout?.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize((old) => { const now = read(); return now.width === old.width && now.rows === old.rows ? old : now; });
    stdout.on("resize", onResize);
    // A resize between the first drawing and this subscription would otherwise go unseen.
    onResize();
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return size;
}

// An uninstall only detects, reviews and removes the packages.
const STEPS_SHOWN: Record<WizardState["mode"], StepId[]> = {
  install: ["detect", "signin", "site", "review", "install", "host", "check"],
  uninstall: ["detect", "review", "install"],
};

/** Part of the run view's left pane, above the slides when both fit: where the run is, step by step. One row per step. */
export const stepsOverviewRows = (state: WizardState) => STEPS_SHOWN[state.mode].length;
export function StepsOverview({ state }: { state: WizardState }) {
  return (
    <Box flexDirection="column">
      {STEPS_SHOWN[state.mode].map((id) => (
        <Text key={id} color={state.steps[id] === "done" ? good() : state.steps[id] === "active" ? accent() : undefined}>{STATUS_MARK[state.steps[id]]} {id === "install" && state.mode === "uninstall" ? "Removing packages" : STEP_TITLES[id]}</Text>
      ))}
    </Box>
  );
}

/** `onQuit` is a confirmed quit: a stop. `onFinish` closes the done card: the run is over, so it is not a stop.
 * `localKey`: --local-key was given (the welcome screen's promises say so). */
export function App({ store, onFinish, onQuit, localKey = false }: { store: WizardStore; onFinish?: () => void; onQuit?: () => void; localKey?: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, rows } = useWindowSize();
  useInput((input, key) => {
    // The store as it is now, not as it was last drawn: keys that arrive together apply in turn (q then y quits).
    const state = store.getSnapshot();
    const ctrlC = key.ctrl && input === "c";
    // Closing ("Stopping…", "Signing out…"): nothing is left to answer. Ctrl-C asks again, and the app leaves at once.
    if (state.closing) { if (ctrlC) onQuit?.(); return; }
    if (!state.started) { if (key.return) store.start(); else if (input === "q" || ctrlC) store.quit(); return; }
    // The done card shows while the flow may still be signing out; every way out of it simply closes it.
    if (state.step === "done") { if (key.return || key.escape || input === "q" || ctrlC) onFinish?.(); return; }
    if (state.quitAsked) { if (input === "y" || ctrlC) onQuit?.(); else if (input === "n" || key.escape) store.dismissQuit(); return; }
    // q quits except while typing an answer (a domain may contain q); Ctrl-C always does.
    if ((input === "q" && state.prompt?.kind !== "text") || ctrlC) store.requestQuit();
  });
  let body;
  if (!state.started) {
    // The slides under the welcome panel once the window is tall enough for both (at least 40 rows) and the
    // two together actually fit at this width (the panel's paragraph and promise panel wrap on a narrow terminal).
    const fitsSlides = rows >= 40 && rows >= HEADER_ROWS + welcomeRows(width, localKey) + 1 + SLIDES_HEIGHT;
    body = (
      <Box flexDirection="column">
        <Welcome localKey={localKey} />
        {fitsSlides && <Box marginTop={1}><Slides /></Box>}
      </Box>
    );
  }
  else if (state.step === "done") body = <Done state={state} />;
  else if (state.step === "signin") body = <Signin state={state} />;
  else if (state.step === "review") body = <Review state={state} width={width} rows={rows} current={store.getSnapshot} />;
  else if (state.step === "install" || state.step === "host" || state.step === "check") {
    // The left pane: the steps overview on top (its own first rows still line
    // up beside the task list's "Tasks" heading the way the resize test expects), the slides below it once the rows
    // they need are there too, or the slides alone if the overview does not also fit, or nothing if neither does. A
    // host hand-off takes the left pane's place entirely before this is ever asked (Run.tsx), so it still stands.
    body = (
      <Run
        state={state} width={width} rows={rows} current={store.getSnapshot}
        left={(room) => {
          const overview = stepsOverviewRows(state);
          if (room >= SLIDES_HEIGHT + overview) {
            return (
              <Box flexDirection="column">
                <StepsOverview state={state} />
                <Slides active={!state.prompt && !state.quitAsked} />
              </Box>
            );
          }
          if (room >= SLIDES_HEIGHT) return <Slides active={!state.prompt && !state.quitAsked} />;
          return room >= overview ? <StepsOverview state={state} /> : null;
        }}
      />
    );
  }
  else body = <Step state={state} width={width} rows={rows} />;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header />
      {body}
      {state.prompt && <Prompt key={state.prompt.id} prompt={state.prompt} active={!state.quitAsked} onAnswer={(v, id) => store.answer(v, id)} />}
      {state.quitAsked && <Text color={accent()}>Quit now? (y / n)</Text>}
      {state.closing && <Text color={muted()}>{state.closing}</Text>}
    </Box>
  );
}
