import type { WizardConfig } from "./config.js";
import type { Runner } from "./run.js";
import type { BasicUi } from "./ui/types.js";

// `signal` is a stop (the caller wires it to Ctrl+C, SIGTERM and a confirmed quit): it aborts a running package
// install or removal, and the flow halts before its next side effect (see halt()). `interactive`: the package install
// or removal runs in the terminal itself (the plain face), so the package manager can ask its own questions (pnpm
// asks before it removes a modules folder) and its output is shown as it writes it. The full screen owns the terminal,
// so there the package manager's output is piped to the Logs tab instead.
export interface CliDeps { cwd: string; config: WizardConfig; open(url: string): void; run: Runner; ui: BasicUi; signal?: AbortSignal; interactive?: boolean }
