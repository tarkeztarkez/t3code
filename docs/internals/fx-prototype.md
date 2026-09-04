# fx execution prototype

This prototype lives in `scripts/fx`. It does not register an fx provider, change
Pi, load the Pi extension factory, or modify a desktop installation. It excludes
subagents. The native executable is not ready for normal T3 conversations.

## What runs

- Native QuickJS and Bun workers execute the same JavaScript tool-composition
  protocol. Each execution gets a new process. Completion, cancellation, and
  deadlines release that process. The host rejects unawaited tool calls.
- The fixture host reuses `pi-codex-conversion`'s shell session manager and native
  patch executor. It caps each shell output buffer at 1 MiB. It does not load Pi's
  agent runtime or change the bundled extension configuration.
- The context loader reads ancestor `AGENTS.md` and `CLAUDE.md` files, user
  instructions, and standalone Claude file imports. It discovers Pi, `.agents`,
  and Claude skill directories. Canonical paths deduplicate symlinks and import
  cycles. Only skill descriptions and paths enter the prompt, not skill bodies.
- The pinned fx patch enables host tools through native ACP and disables native
  tools and ACP MCP servers on that path. It carries session identity through
  prepared requests and serializes Codex's `prompt_cache_key`.

The worker protocol currently supports `tools.name(input)` and `text(value)`.
It is not yet the complete conversion extension's `exec` and `wait` contract.

## Build and verify

Use Bun for the host scripts. The repository dependencies must already be
installed. Native builds require Git, CMake and a C compiler for QuickJS, and
Zig 0.16.0 for fx. `sources.json` pins both source commits. Build directories
must not exist; the build script never resets an existing checkout.

On Linux, run builds under the CPU quota wrapper:

```sh
~/.agents/skills/half-cpu/scripts/half-cpu bun scripts/fx/build.mjs quickjs /tmp/t3-qjs-build
~/.agents/skills/half-cpu/scripts/half-cpu bun scripts/fx/build.mjs fx /tmp/t3-fx-build

FX_QUICKJS_BINARY=/tmp/t3-qjs-build/build/qjs bun test scripts/fx/*.test.mjs
bun scripts/fx/benchmark.mjs /tmp/t3-qjs-build/build/qjs

cd /tmp/t3-fx-build
~/.agents/skills/half-cpu/scripts/half-cpu zig build test -Doptimize=ReleaseFast -Dtest-filter='OpenAI Codex request uses'
```

Without `FX_QUICKJS_BINARY`, tests report that they omitted the QuickJS cases.
That is not parity verification. Do not install either prototype executable as
a replacement for T3 or a user's fx CLI.

## Isolation and memory

These workers are for trusted fixtures only. Neither Bun's dynamic functions
nor the stock QuickJS CLI is an OS sandbox. QuickJS's standard modules can
access the filesystem and launch processes. An empty environment does not
remove those capabilities. Do not connect model-generated code to this host
until the production isolation policy is implemented.

The parent enforces a deadline, a 64 KiB source limit, 1 MiB message and output
limits, and at most 64 pending tool calls. QuickJS also has a 32 MiB engine heap
limit and a 1 MiB stack limit. These are not whole-process memory limits. Bun
has no corresponding hard heap limit in this prototype. Host tool callbacks
must honor their abort signal and own cleanup of their subprocesses.

The benchmark alternates engines over 15 rounds. It reports median worker
startup, elapsed execution time, RSS, and the worker's RSS high-water mark
sampled at the last host call. It excludes T3, fx, shell subprocesses, and model
requests. It does not measure CPU usage or prove a whole-app improvement over
Pi. It uses native QuickJS, not QuickJS compiled to WebAssembly inside Bun.

## Caching

Capture instructions and tool definitions once per conversation, then persist
that snapshot with its resume state. `cache.mjs` produces deterministic tool
ordering, a prefix hash for diagnostics, and an account/thread-scoped cache
key. This helper is not yet connected to T3 persistence or native fx session
creation. The native patch currently uses fx's own session ID.

Keep turn IDs, request IDs, timestamps, refreshed bearer tokens, and runtime
statistics out of the stable prefix. Refresh context explicitly when files or
skills change. Do not silently rebuild the prefix on every turn. Sorting JSON
object keys must not reorder schema arrays such as enum values.

The native patch propagates session identity into the prepared request body as
well as the direct serialization path. Changing only the final send function
would miss fx's prebuilt bodies. Requests retain encrypted reasoning replay and
`store: false`. Prompt caching does not require enabling response storage.

The patch does not add a keepalive, prewarming request, WebSocket transport, or
an unsupported cache-retention setting. Those can cost money or change server
behavior. A cache key is a routing hint, not a cache-hit guarantee. Use the
provider's reported cached input token count to measure actual reuse.

## Missing before release

There is no T3 driver, Codex auth bridge, or client selection UI yet. Native fx
still has its upstream credential behavior. Do not point this prototype at
the user's live credentials or T3 state.

Production integration still needs the complete Code Mode execution lifecycle,
image delivery, MCP discovery and calls, questions, approvals, custom tool
loading, and the remaining applicable bundled-extension behavior. The current
fixture host implements shell and patch calls only. Subagents remain excluded.

The auth bridge must read `~/.codex/auth.json`, refresh and persist rotated
credentials, and handle external Codex refreshes and account changes. Reference
Codex's `codex-rs/login/src/auth/manager.rs` and `storage.rs`. A T3-only mutex
cannot coordinate another process that writes the same file.

The eventual driver must persist fx resume state and cache identity, expose
cached-token usage, and cover provider selection, model controls, approvals,
questions, reconnects, and cancellation across web, desktop, and mobile.
Credentials and tool effects belong to the environment server, including for
remote and tunnel clients. Pi and its bundled defaults stay unchanged.
