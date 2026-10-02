import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { layout } from "./html.js";

const app = new Hono();

app.get("/", (c) => c.html(layout("Outdoor shop", "<h1>Grills and tents</h1>")));

serve({ fetch: app.fetch, port: 3000 });
