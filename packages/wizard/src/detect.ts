// Compatibility: the workspace helpers live in workspace.ts and the Next.js detection in integrations/nextjs.ts. This
// module keeps the names existing imports (and tests) use.
export { DetectError, findRoot, type PackageManager } from "./workspace.js";
export { detectApp, findNextApps, type NextApp } from "./integrations/nextjs.js";
