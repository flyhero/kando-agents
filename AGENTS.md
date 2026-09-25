# Ripen

Task-first multi-agent manager. See README.md for the architecture diagram.

## Process boundaries

- **daemon** owns every PTY. **core** owns tasks, git and persistence. **desktop** and **cli** are clients only.
- Electron main stays thin: no task logic, no git, no PTYs. A window closing or crashing must never touch a running agent.
- Native modules (node-pty) load only in the daemon, which runs on plain Node. Never import a native module into Electron.
- core must stay free of Electron imports so it can run headless on a server.

## Protocol

- `packages/protocol` is the single source of truth. Define a new RPC method or notification there as a zod schema, then implement it in `core/src/rpc-handlers.ts`.
- Clients and core can be on different versions. Adding an optional field is safe. A breaking change bumps `PROTOCOL_VERSION`, or `DAEMON_PROTOCOL_VERSION` for the daemon wire.
- Index `rpcSchemas` / `daemonSchemas` with a generic method name. Indexing the raw `rpcMethods` widens to a union of every schema.
- Status rules live in `checkMove` / `checkRun` / `manualMoves`. The UI and CLI call them; they never re-encode the rules.

## Safety

- core binds to 127.0.0.1 only and requires the token from `core.json`: any web page can open a localhost WebSocket.
- Agent commands are argv arrays with `--` before the prompt. Never go through a shell.
- Only a refused connection proves a daemon socket is stale. A timeout or EPERM proves nothing.
- Worktrees are never deleted automatically: they may hold the only copy of an agent's work.

## Style

- Keep comments brief and non-obvious (why, not how).
- Avoid type assertions except `as const`.
- Name files after the concept they hold, never `utils` or `helpers`.
- Cross-platform: keep platform checks explicit (named pipes on Windows, `spawn-helper` on macOS).

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
- **scope**: the package: `protocol`, `core`, `daemon`, `cli` or `desktop`. Leave it out when the change spans packages.
- **summary**: imperative, present tense, lowercase first letter, no trailing period, under 72 characters.
- **body**: why the change is needed, and how behavior differs from before. Required except for `docs` and `chore`.
- **footer**: `BREAKING CHANGE: <summary>` plus migration steps for anything that bumps `PROTOCOL_VERSION` or `DAEMON_PROTOCOL_VERSION`. `Fixes #<issue>` when there is one.
- One self-contained change per commit, with its tests. No `Co-Authored-By` trailers for agents.

```
refactor(protocol): drop the ~/.ripen fallback

The only install has moved to ~/.kando, so RIPEN_HOME and the ripen.db
lookup are branches nothing reaches.
```
