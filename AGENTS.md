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
