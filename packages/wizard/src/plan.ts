// Compatibility: the plan's shared parts live in plan-core.ts and the Next.js plan in integrations/nextjs.ts. This
// module keeps the names existing imports (and tests) use.
export * from "./plan-core.js";
export { installPlan, uninstallPlan } from "./integrations/nextjs.js";
