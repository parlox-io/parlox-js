import { Box, Text } from "ink";
import { accent, muted } from "../theme.js";
import { wrapWords } from "../../ui/text.js";

const PARAGRAPH = "Parlox shows which AI agents visit your store, what they read, where they get stuck, and whether they buy.";
const STEPS = ["Find your apps: Next.js, Vite React, Express, Hono", "Sign in in your browser", "Pick your site", "Review the changes before anything is written", "Install and connect your host"];
// The promises this run keeps. With --local-key the person asked for a key on this computer, so the second promise
// says what happens instead of promising what this run will not keep. The wizard's keys can only send crawler
// reports. Each promise fits one row of the panel at 100 columns.
const promises = (localKey: boolean) => [
  "shows every change as a diff first, and can undo it (npx parlox uninstall)",
  localKey ? "puts a key for crawler reports only in your local env file, because you asked (--local-key)" : "never puts your secret key on this computer",
  "never sends your code anywhere, and has no tracking",
];

export function Welcome({ localKey = false }: { localKey?: boolean }) {
  const PROMISES = promises(localKey);
  return (
    <Box flexDirection="column">
      <Text>{PARAGRAPH}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>What happens</Text>
        {STEPS.map((s, i) => (<Text key={s}>{`  ${i + 1}  ${s}`}</Text>))}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor={muted()} paddingX={1} flexDirection="column">
        <Text bold>This wizard</Text>
        {PROMISES.map((p) => (<Text key={p}>{`✔ ${p}`}</Text>))}
      </Box>
      <Box marginTop={1}><Text color={accent()} bold>Press Enter to start</Text><Text color={muted()}>   q to quit</Text></Box>
    </Box>
  );
}

/** Rows this screen takes at `width` columns (the app's own side padding already taken out of it): the paragraph and
 * the promise panel wrap at narrow widths, so this is computed rather than guessed. Used to decide whether the
 * slides also fit underneath it (App.tsx), alongside the room the app keeps free below 40 rows regardless. */
export function welcomeRows(width: number, localKey = false): number {
  const PROMISES = promises(localKey);
  const inner = Math.max(1, width - 2); // the app's own side padding (paddingX={1} on each side)
  const panelInner = Math.max(1, inner - 2 - 2); // the panel's border (2) and its own paddingX (2)
  const paragraphRows = wrapWords(PARAGRAPH, inner).length;
  const panelRows = 2 + 1 + PROMISES.reduce((n, p) => n + wrapWords(`✔ ${p}`, panelInner).length, 0); // border + "This wizard"
  return paragraphRows + 1 + 1 + STEPS.length + 1 + panelRows + 1 + 1; // margins between blocks, "What happens", the footer
}
