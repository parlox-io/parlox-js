// @parlox/browser/react: one component for React and Next.js (App Router or Pages Router).
//
//   import { ParloxAnalytics } from "@parlox/browser/react";
//   <ParloxAnalytics publicKey="pk_..." />   // in the root layout
//
// It renders nothing and starts Parlox once, after hydration, in the browser. The built file carries "use client".

import { useEffect } from "react";
import { init, type InitOptions } from "./index.js";

export function ParloxAnalytics(props: InitOptions): null {
  const publicKey = props.publicKey, consent = props.consent, recordAgents = props.recordAgents, endpoint = props.endpoint;
  useEffect(() => {
    init({ publicKey, consent, recordAgents, endpoint });
  }, [publicKey, consent, recordAgents, endpoint]);
  return null;
}

export { init, track, consent, sessionId } from "./index.js";
export type { InitOptions, CommerceProps } from "./index.js";
