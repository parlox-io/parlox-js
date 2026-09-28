// The hosted recorder (/sdk/<version>/parlox-record.js). The tag sets window.__plxRec and adds this script with its
// integrity hash; tags cached from before versioned releases load the unversioned /sdk/parlox-record.js, which is
// this same file.

import { startRecorder } from "./recorder.js";
import type { RecorderConfig } from "./tracker.js";

try {
  const cfg = (window as unknown as { __plxRec?: RecorderConfig }).__plxRec;
  if (cfg && typeof cfg.endpoint === "string") startRecorder(cfg);
} catch { /* never break the page */ }
