import type { Detection, Integration, IntegrationId } from "./types.js";
import { nextjs } from "./nextjs.js";
import { viteReact } from "./vite-react.js";
import { express } from "./express.js";
import { hono } from "./hono.js";

/** Every stack the wizard installs into, in the order a folder is checked. */
export const INTEGRATIONS: Integration[] = [nextjs, viteReact, express, hono];

export function integrationOf(d: Pick<Detection, "integration"> | IntegrationId): Integration {
  const id = typeof d === "string" ? d : d.integration;
  const found = INTEGRATIONS.find((i) => i.id === id);
  if (!found) throw new Error(`No integration named ${id}`);
  return found;
}
