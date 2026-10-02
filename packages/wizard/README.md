# parlox

Install Parlox agent analytics into a **Next.js, Vite React, Express or Hono** project, or a repo that has a frontend
and a backend: one command, one diff to confirm, and your secret key stays off your machine by default (only
`--local-key` puts a separate key in your app's env file, one that can only send crawler reports, because you asked
for it).

```bash
npx parlox init
```

(`npx parlox` with no command does the same thing.) Another stack? See https://gateway.parlox.io/install.md

## What it installs, per stack

| Stack | Browser part | Server part (sees AI fetchers and crawlers, answers the ownership check) |
|---|---|---|
| Next.js 13+ | `<ParloxAnalytics />` in the root layout or `_app` | `withParlox()` in `middleware.ts` / `proxy.ts` |
| Vite React | `<ParloxAnalytics />` beside `<App />` in the entry `index.html` names | On Vercel: a `middleware.ts` (Vercel Routing Middleware) that runs on page requests, not assets, added only when the wizard can prove the build cannot put the key into the browser code (when Vercel is set up at the workspace root, also only when the project's Root Directory is known to be the app folder: run `vercel link` in the app, or `vercel pull` at the root); otherwise the app gets the browser part only, and the report says why. Elsewhere: none (a static site has no server), so crawlers that do not run JavaScript are not seen. Wherever there is no middleware, the wizard writes `public/.well-known/parlox-verify` so the domain can still be verified |
| Express 4 and 5 | The pinned Parlox tag, after a `parlox:wizard` marker comment, in each view with a `<head>` (EJS, Handlebars, Mustache, Nunjucks, Eta, Liquid, Pug or Jade; another view engine is a step by hand) or static `.html` page, at most 20 pages per app (with more, a step by hand) | `app.use(parlox())` right after `const app = express()`, before your routes |
| Hono (Node, Bun, Cloudflare Workers and Pages, Vercel, AWS Lambda) | The pinned tag, after the same marker, in your one JSX layout or `html` template with a `<head>` | `app.use(parlox())` right after `new Hono()` |

A folder with a Vite frontend served by its own Express or Hono server gets both: the component in the Vite entry, the
middleware in the server file. Hosts usually give the build the same variables as the server, so the server part and
its key are added only when the wizard can prove that no Vite build in the folder could put the key into the browser
code; otherwise the app gets the browser part only, and the report says why. A `$` in a `.env` file that Vite loads
when it builds, or that Bun loads when Bun runs the build, also withholds the key: both expand `$NAME` there from the
build's environment, so the file could copy the key into a `VITE_` variable, which Vite puts in the browser code. The
same check runs on every host, Cloudflare Workers included: whether an app deploys only as a Worker, whose runtime
secrets the build does not see, cannot be read from its files (Workers Builds and other Git-connected hosts leave no
trace in the repository). For a Hono app on Workers the host hand-off also says to add the key as a runtime secret
(Settings → Variables & Secrets), not as a build variable. The wizard takes a Hono app with wrangler's config to run on
Workers only when nothing says otherwise: no other host's file or link (a Vercel link, `vercel.json` or `now.json`,
`netlify.toml` or a `netlify/` folder, `fly.toml`, `render.yaml`, `railway.*`, a `Dockerfile` or `Dockerfile.<name>`, a
`Containerfile`, a Compose file, a `Procfile`, `nixpacks.toml`, `serverless.yml`, `app.yaml`) in the app folder or any
folder above it up to the top of the repository, and no other runtime in its dependencies, its scripts or its code
(`@hono/node-server`, `@hono/aws-lambda`, `hono/vercel`, `hono/aws-lambda`, `hono/bun`, `hono/deno`,
`hono/lambda-edge`, `hono/netlify`, `srvx`, `@vercel/node`, the `vercel` CLI, `@netlify/functions`, `serverless-http`;
Bun's types, or a `dev` or `start` script that runs `bun`; `Bun.serve()` or `Deno.serve()`). With any of them, the
report and the hand-off name the runtime the evidence names (or none, where it names none), and beside another host's
file, wrangler's config does not make Cloudflare the host.

An Express or Hono app that already reports to Parlox with its own code (a `fetch` to `/v1/s`, or `PARLOX_SECRET_KEY`
used outside `@parlox/server`) gets no server part, since it would count each visit twice; the report names the file
and line.

In a monorepo run at the root, the wizard lists the apps it found and asks which to include (all are selected; a
folder the workspace's own list leaves out with a `!` pattern is not offered, as npm and pnpm read that list); one
diff and one Yes cover them all, and each app with a server part gets its own key, with the app's folder in its name
(only in a run with several apps), so each can be revoked on its own. Off Vercel you create that key yourself, from the
dashboard form the wizard opens with its name filled in.

Every key the wizard creates can only send crawler reports (no orders, no reading your stats), and the dashboard key
form it opens for other hosts has "Crawler reports only" chosen: a key that a host's build can also read can then, at
worst, add false crawler reports to your site. To record orders with `purchase()`, create a key with the access "Send:
crawler reports and orders" in the dashboard (Settings → Keys); the wizard's key can only send crawler reports.

Where a file cannot be edited safely (it will not parse, the app is created twice, a layout has two `<head>`s), the
wizard shows the exact snippet to paste and where, instead of guessing.

## Full screen, or plain

In a real terminal, `parlox` opens a full-screen guided app: a menu of what it found, a scrollable diff to review,
and a live view of the install running. It falls back automatically to a plain, line-by-line session that asks the
same questions and shows the same diff as plain text whenever the terminal isn't interactive (not a TTY, `CI` is set,
the window is smaller than 80×24, `TERM=dumb`, or you're on an old-style Windows console), or when you pass `--yes`
or `--plain`. `NO_COLOR` (set to anything) turns off colour in both.

## What it does

1. **Looks at your project**, read-only: which stack each app uses, its entry or server file, TypeScript, the
   module system, the package manager, whether the app loads a `.env`. Nothing is written yet.
2. **Signs you in** at Parlox's sign-in page, opened in your browser (OAuth with PKCE, on a loopback port on your
   machine). If the browser does not open, the wizard shows a short link on your machine that forwards to it.
3. **Asks which site** this project is (or creates one). With `--site <domain>` it picks that site without asking.
4. **Plans the change and shows you the diff** before touching anything, and the commands it would run.
5. **Applies it**, once you agree (or at once under `--yes`), and runs your package manager to add the Parlox
   packages at exact, tested versions (`@parlox/browser@1.0.3`, `@parlox/server@1.1.0`; for Vite on Vercel also
   Vercel's own `@vercel/functions`, if the project does not have it).
6. **Connects your host**, per app with a server part: on a linked Vercel project (and you're signed in to the Vercel
   CLI) it asks, then creates a key that can only send crawler reports and sets `PARLOX_SECRET_KEY` and
   `PARLOX_VERIFY_TOKEN` through `vercel env add` on standard input. It checks the key's access in the gateway's
   answer: a key that is not "Crawler reports only" is never used (here or for `--local-key`), and the wizard names
   it for you to revoke; it then creates no other key in that run (that gateway would answer each the same way), and
   every app's key is a step by hand. The key is stored as a Secret (`--visibility secret`) when your Vercel CLI has that option,
   otherwise as sensitive (`--sensitive`), and the report says which: either way no one can read it back from Vercel,
   and your deployments and builds still receive it. `PARLOX_VERIFY_TOKEN` is a normal variable (it is public). A
   `PARLOX_SECRET_KEY` already set there is left as it is; on a static Vite site, and for an Express or Hono server
   beside a Vite build in its folder, the report asks you to check in Settings → Keys that it is "Crawler reports
   only", since the wizard cannot see that key and that build can read it too. Everywhere else it opens the Parlox dashboard's
   key form (in an interactive run; the link is always printed) with the key's name filled in and "Crawler reports
   only" chosen, and shows the two variables and where to paste them on that host.
7. **Offers a local check** where the app loads its token locally (Next.js; Express and Hono apps that load a
   `.env`): with your dev server running, it asks it for `/.well-known/parlox-verify`.
8. **Reports what happened**, each line labelled with how it knows: "added to your code", "verified locally",
   "confirmed after you deploy", "not checked", and what is not covered on your stack and why. Ownership of the
   domain is said to be confirmed after the deploy only when something added (or already there) proves it: a server
   part, the ownership file, or a tag in the HTML your server sends; otherwise the report says how to prove it (the
   DNS record, or the server part by hand). Where a server part was withheld and nothing else was added, it never says
   Parlox is installed. For an Express or Hono server on a host that keeps it running between requests (Fly.io,
   Render, Railway, a Docker container), one line points to the shutdown snippet in `@parlox/server`'s README: reports
   wait in a queue there, and a stop on a signal loses them unless your shutdown code sends them first.

## Files it changes

- The browser part and the server part, as in the table above.
- An env file, only where your app already loads one:
  - Next.js: `.env.local`, which Next.js loads itself. One that git tracks, or that is a link, is left alone: the app
    gets the line to add by hand (or `git rm --cached` it and run again), and no local key; the run goes on.
  - Express and Hono on Node or Bun: the `.env` file your app loads. The wizard looks in the script that starts the
    app (`dev`, else `start`, and the scripts it runs) for `--env-file` or `--env-file-if-exists` (Node, Bun, tsx), a
    preloaded `dotenv/config` or `@dotenvx/dotenvx/config` (`-r`, `--require`, `--import`), dotenv-cli
    (`dotenv -e <file>`), env-cmd (`env-cmd -f <file>`), `dotenv run` and `dotenvx run`; in the server file for an
    `import` or `require()` of either config module, dotenv's or dotenvx's `config()`, and `process.loadEnvFile()`;
    then for Bun, which reads `.env` by itself; and last for a `dotenv` or `@dotenvx/dotenvx` dependency (an
    inference, and the report says so). It writes only `.env`, `.env.<name>` or `.env.<name>.local` in the app's own
    folder; a loader of any other file is named in the report instead. A `.env` that git tracks, that is a link, or
    that the wizard may not read (larger than 1 MB) is left alone: the app gets the line to add by hand, and no local
    key.

  Only `PARLOX_VERIFY_TOKEN` goes there (it is not a secret: it proves you own the domain), plus, with `--local-key`,
  a separate key that can only send crawler reports. If the app loads no `.env`, no env file is written and no loader
  is added (the server part is still added); the report says what to set. A new env file is readable only by you (on
  macOS and Linux). The wizard never writes `PARLOX_SECRET_KEY` where Vite would put it in the browser build (a
  `VITE_` name, or an `envPrefix` it starts with).
- `.gitignore`: adds that env file if git does not already ignore it.
- `public/.well-known/parlox-verify` (a Vite site without the middleware): the domain's verification code. Also for
  Vite React beside an Express server whose server part is withheld, when that is Express 4 (4.10 or later), which
  serves files inside `.well-known/`, and its server file shows `app.use(express.static(…))` serving the build (or the
  public folder) at the site's root with nothing before it that could answer first. Express 5 does not serve them by
  default, so there the report says how to prove the domain instead.
- `package.json` and your lockfile, through your own package manager.

Every edit keeps your file's formatting, quotes, semicolons, line endings and comments, and is made at a place the
syntax tree (or, for HTML and Pug, one unique anchor) says is right; nothing else in the file is reprinted. An env file
is the exception: it is written line by line, so a missing final newline is added and mixed line endings become one
kind.

## What it never does

- Never stores a secret key on your machine unless you ask for a local one with `--local-key`. A new production key
  goes straight to Vercel's CLI on standard input and is never written to disk, logged, or printed.
- Never shows the other variables in your env file: its diff shows only the `PARLOX_VERIFY_TOKEN` line, each other
  line it adds or removes as a stand-in ("[your line 1, not shown]"), and how many other lines the file has. The same
  in the full screen, the plain output and CI logs.
- No telemetry, and no AI: the edits are fixed templates shown as a diff first. Your code is never sent anywhere; the
  only details of your machine or project it sends are in the names of the keys it creates (an app's folder, in a run
  with several apps, and with `--local-key` your computer's name).
- Never starts your app. It adds only the Parlox packages (and, for Vite on Vercel, `@vercel/functions`); never
  `dotenv` or another loader. It never replaces your existing middleware: it wraps it, or shows a snippet.
- Talks only to:
  - `gateway.parlox.io`;
  - Parlox's sign-in service, hosted on Supabase (`*.supabase.co`);
  - your own dev server on `localhost`, for the local check;
  - your package manager, which adds or removes the packages;
  - on a linked Vercel project, unless you pass `--no-vercel`, your own `vercel` CLI: first `vercel --version` and
    `vercel whoami`, to check that you are signed in, before it asks you anything about Vercel; then, only if you
    accept, `vercel env ls` and `vercel env add`.

  Besides those it runs only read-only `git` commands, your system's command that opens a link in your browser (unless
  you pass `--no-browser`), and on Windows `taskkill`, to stop a package install you interrupt. (The browser may open
  the dashboard at `app.parlox.io` for the key hand-off; the wizard itself never contacts it.)
- Refuses to touch anything outside your project folder, and never follows a symlink to write through it.
- Requires a git repository with a clean working tree by default (`--allow-no-git`, `--allow-dirty` to override).

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Show the plan and diff; write nothing, install nothing, create no site or key, open no hand-off. |
| `--yes` | Accept the diff and the package install without asking, and create the `--site` domain's site if your account does not have it. The local check is skipped unless `--url` is given. Without a terminal (CI), the wizard refuses to start unless `--yes` is given, and any question still left stops the run at once with what to pass instead. |
| `--app <folder>` | Include this app (repeatable: `--app web --app api`). Without it, a run at a monorepo root asks which apps to include; with no terminal to ask in, it stops and lists the apps. |
| `--plain` | Use the plain, line-by-line session instead of the full-screen app. |
| `--allow-dirty` | Continue with uncommitted changes (with `--yes`; otherwise you're asked). |
| `--allow-no-git` | Continue when the project isn't a git repository (with `--yes`; otherwise you're asked). |
| `--no-browser` | Don't open your browser for sign-in or the key hand-off; print the links instead. |
| `--site <domain>` | Use the site with this domain instead of asking. |
| `--url <local url>` | Run the local check against this URL without asking (a run with at most one app whose server part can be checked locally; a static site's ownership file does not count). |
| `--skip-check` | Skip the local check. |
| `--vercel` | Accept the Vercel production-variables step without asking. For a Vite site with no host file, also says it deploys on Vercel (so it gets the middleware, where its build is proven safe). |
| `--no-vercel` | Skip the Vercel step; print the variables to set by hand. For a Vite site with no host file, also says it does not deploy on Vercel. |
| `--local-key` | Also create a separate key that can only send crawler reports, "local dev · <computer name>", and write it to the app's env file, so the server part reports from your dev server (visits to it then appear in the site's real data; revoke the key in Settings → Keys when done). No key is written where the app loads no env file, where that file is a step by hand or already has a `PARLOX_SECRET_KEY`, or where Vite could put it into the browser build; the run says why. |
| `--debug` | On an error, print details (a stack trace, with any secret pattern replaced by `[hidden]`). |

## What it does not cover (yet)

- Shopify, WordPress / WooCommerce: dedicated apps are planned.
- React Router 7 in framework mode / Remix / Hydrogen, TanStack Start, Vike, Astro, Waku, RedwoodJS, SvelteKit, Nuxt,
  Vue or Svelte on plain Vite, NestJS, HonoX, Deno projects without a `package.json`, Hono on Deno, Fastly or
  Lambda@Edge: the wizard says so and points to the install guide.
- Static sites off Vercel (Netlify, Cloudflare Pages, GitHub Pages, S3): browser part only; crawlers that never run
  JavaScript are not seen there. Pages a CDN serves from its cache never reach your server either.
- HTML built at runtime from strings, an app created in more than one place, or an `express()` / `new Hono()` not
  assigned to a variable: a snippet to paste.

## Uninstall

```bash
npx parlox uninstall
```

Shows a diff of what it would remove, then takes out exactly what it added: the component, the middleware line and
its import (or the whole middleware file if the wizard created it), the tags it wrote in your pages (only those after
its `parlox:wizard` marker: a tag you pasted yourself stays), the ownership file, the `PARLOX_VERIFY_TOKEN` line in
your env file (the file itself when nothing else is left in it), and the Parlox packages (`@vercel/functions` stays:
your project may use it). Two things stay, and the review and the report say why: `@parlox/server`, while a file of
your own still imports it (your `purchase()` code, say; the wizard reads at most 2000 source files, none over 1 MB
and none through a link, and keeps the package when it could not read them all), and a `PARLOX_SECRET_KEY` line, since the wizard cannot tell a key
`--local-key` wrote from your own; delete that line yourself if it is the local key. Files the wizard edited go back byte for byte, except the env file: taking Parlox's lines out also adds a
missing final newline and makes mixed line endings one kind. It leaves `.gitignore` as it is, since the line the
install added keeps your env file out of git, and the report says so. It does not revoke any key: do that in the
dashboard (Settings → Keys); if you used `--local-key`, revoke the key named "wizard · local dev · …" there too. What
it may not change itself (an env file git tracks, a file it may not read) is listed as a step by hand; an app whose
only finding is such a step is offered too, and is never said to be removed. A file it may not read (a link to a
shared `.env`, say) counts only in an app Parlox is in (a `@parlox/*` dependency, or a file it read that holds
Parlox's line): elsewhere the run says there is nothing to remove, and names that file.
