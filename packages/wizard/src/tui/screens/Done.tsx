import { Box, Text } from "ink";
import { BY_HAND, BY_HAND_ON_CARD, STEPS_ABOVE, STEPS_ON_CARD } from "../../ui/types.js";
import type { WizardState } from "../store.js";
import { accent, good, muted } from "../theme.js";

/** The report card. It is drawn before anything is printed, so it never points "above": the code to add by hand (an
 * uninstall's steps by hand too), this report and the host hand-off are printed when the wizard closes, and the card
 * says so. */
export function Done({ state }: { state: WizardState }) {
  const lines = (state.report ?? []).map((l) => l.split(BY_HAND).join(BY_HAND_ON_CARD).split(STEPS_ABOVE).join(STEPS_ON_CARD));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={good()} paddingX={1}>
      <Text color={good()} bold>{state.reportTitle ?? "Done"} ✔</Text>
      <Box flexDirection="column" marginTop={1}>{lines.map((l, i) => (<Text key={i}>{l}</Text>))}</Box>
      <Box marginTop={1}><Text color={muted()}>{state.handoff ? "This report and what to set on your host are printed when you close the wizard." : "This report is printed when you close the wizard."}</Text></Box>
      <Box marginTop={1}><Text color={accent()}>Press Enter to finish</Text></Box>
    </Box>
  );
}
