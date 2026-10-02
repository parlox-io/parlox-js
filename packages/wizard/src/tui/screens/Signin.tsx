import { Box, Text } from "ink";
import { isSigninLink } from "../../ui/types.js";
import { messagesSince, type WizardState } from "../store.js";
import { accent, muted } from "../theme.js";
import { Messages } from "./Messages.js";

/** The browser sign-in: the instruction with its link (the latest one, if the flow gave more than one) and a waiting
 * line while the sign-in waits, then whatever else the sign-in step has said. Once the step has ended (a stop, a
 * failure), the link leads nowhere and nothing is being waited for, so neither is shown. */
export function Signin({ state }: { state: WizardState }) {
  const messages = messagesSince(state, "signin");
  const waiting = state.steps.signin === "active";
  const link = [...messages].reverse().find((m) => isSigninLink(m.text));
  const [first, ...rest] = (link?.text ?? "Approve access in your browser.").split("\n");
  const others = messages.filter((m) => !isSigninLink(m.text)).slice(-3);
  return (
    <Box flexDirection="column">
      <Text bold>Signing in</Text>
      {waiting && (
        <Box marginTop={1} flexDirection="column">
          <Text>{first}</Text>
          {rest.map((l, i) => (<Text key={i} color={accent()}>{l}</Text>))}
          <Box marginTop={1}><Text color={muted()}>◐ Waiting for your approval in the browser…</Text></Box>
        </Box>
      )}
      <Messages list={others} />
    </Box>
  );
}
