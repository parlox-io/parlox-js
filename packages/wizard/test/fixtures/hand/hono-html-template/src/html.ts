import { html, raw } from "hono/html";

export const layout = (title: string, body: string) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title} | Outdoor shop</title>
  </head>
  <body>${raw(body)}</body>
</html>`;
