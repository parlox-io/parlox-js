// Compiled with tsc --noEmit (strict) by npm test: the adapter must fit Hono's own middleware type, with typed bindings.
import { Hono } from "hono";
import { parlox } from "../src/hono.js";

type Bindings = { PARLOX_SECRET_KEY: string; DB: unknown };
const app = new Hono<{ Bindings: Bindings }>();
app.use(parlox());
app.use("*", parlox({ includeApi: true }));
app.get("/", (c) => c.text("ok"));
export default app;
