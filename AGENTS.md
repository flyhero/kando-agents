# Kando

Task-first multi-agent manager. See README.md for the architecture diagram.

## Process boundaries

- **daemon** owns every agent process and PTY. **core** owns tasks, git and persistence. **desktop** is a client only, and so is core's MCP server (`mcp-main.ts`), a process of its own that agents start.
- **desktop main** holds the built-in browser's tabs (`WebContentsView`) and runs the browser host; core connects to it over its loopback WebSocket, finding it through the host file, and keeps the policy (which conversation owns a tab, which sites the user allowed). With no app running there is no browser.
- Electron main stays thin: no task logic, no git, no PTYs. Browser tabs are the one exception, and they live in main rather than in a window for the same reason: a window closing or crashing must never touch a running agent, nor a page it is on.
- Native modules (node-pty) load only in the daemon, which runs on plain Node. Never import a native module into Electron.
- core must stay free of Electron imports so it can run headless on a server.

## Protocol

- `packages/protocol` is the single source of truth. Define a new RPC method or notification there as a zod schema, then implement it in `core/src/rpc-handlers.ts`.
- Clients and core can be on different versions. Adding an optional field is safe. A breaking change bumps `PROTOCOL_VERSION`, or `DAEMON_PROTOCOL_VERSION` for the daemon wire.
- Index `rpcSchemas` / `daemonSchemas` with a generic method name. Indexing the raw `rpcMethods` widens to a union of every schema.
- Status rules live in `checkMove` / `checkStart` / `manualMoves`. The UI calls them; it never re-encodes the rules.

## Safety

- core binds to 127.0.0.1 only and requires the token from `core.json`: any web page can open a localhost WebSocket.
- Agent commands are argv arrays with `--` before the prompt. Never go through a shell.
- Only a refused connection proves a daemon socket is stale. A timeout or EPERM proves nothing.
- Worktrees are never deleted automatically: they may hold the only copy of an agent's work. A worktree goes only when the user cleans it, or when it provably holds nothing: a planning checkout once its task runs. Either way it is removed without force, and never one with changes or a commit no ref contains.

## Style

- Keep comments brief and non-obvious (why, not how).
- Avoid type assertions except `as const`.
- Name files after the concept they hold, never `utils` or `helpers`.
- Cross-platform: keep platform checks explicit (named pipes on Windows, `spawn-helper` on macOS).
- Visual decisions (colour, type, spacing, radius, the chat's row rhythm) follow `DESIGN.md`; read tokens from `styles.css`'s `:root`, never hard-code a colour.

## Verify

`pnpm typecheck && pnpm test`, plus `pnpm build` for desktop changes.

## Commits

A trimmed version of Angular's [commit message format](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md).

```
<type>(<scope>): <summary>

<body>

<footer>
```

- **type**: `feat` (new feature), `fix` (bug fix), `refactor` (neither), `perf`, `test`, `docs`, `build` (build, dependencies, scripts), or `chore` (repo housekeeping that fits nothing else, like `.gitignore`).
- **scope**: the package: `protocol`, `core`, `daemon` or `desktop`. Leave it out when the change spans packages.
- **summary**: imperative, present tense, lowercase first letter, no trailing period, under 72 characters.
- **body**: why the change is needed, and how behavior differs from before. Required except for `docs` and `chore`.
- **footer**: `BREAKING CHANGE: <summary>` plus migration steps for anything that bumps `PROTOCOL_VERSION` or `DAEMON_PROTOCOL_VERSION`. `Fixes #<issue>` when there is one.
- One self-contained change per commit, with its tests. No `Co-Authored-By` trailers for agents.

```
refactor(protocol): drop the ~/.ripen fallback

The only install has moved to ~/.kando, so RIPEN_HOME and the ripen.db
lookup are branches nothing reaches.
```
