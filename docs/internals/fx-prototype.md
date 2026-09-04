# fx execution prototype

The runtime code lives in `apps/server/src/provider/fx`, with build and execution
fixtures in `scripts/fx`. It does not register an fx provider, change Pi, or load
the Pi extension factory. It excludes subagents. The native executable is not
ready for normal T3 conversations.

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
- The server auth manager reads `~/.codex/auth.json`. It refreshes tokens, detects
  observed external rotations and account changes, and preserves unrelated file
  fields and symlinks. Concurrent callers share refresh work and failures.
- An account-bound transport forwards only Codex model discovery and Responses
  requests. A private loopback proxy streams responses to the native process.
  The native session bridge selects Codex with host-managed auth, initializes
  host tools, handles cancellation, and loads saved native conversations.
- The isolated QuickJS executable exposes no standard OS modules or module
  loader. Its guest can access host effects only through the supplied callbacks.

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

FX_QUICKJS_BINARY=/tmp/t3-qjs-build/build/qjs \
FX_ISOLATED_BINARY=/tmp/t3-qjs-build/build/fx-code-worker \
bun test scripts/fx/*.test.mjs
bun scripts/fx/benchmark.mjs /tmp/t3-qjs-build/build/qjs

FX_NATIVE_BINARY=/tmp/t3-fx-build/zig-out/bin/fx \
FX_ISOLATED_BINARY=/tmp/t3-qjs-build/build/fx-code-worker \
bunx --no-install vp test run apps/server/src/provider/fx

cd /tmp/t3-fx-build
~/.agents/skills/half-cpu/scripts/half-cpu zig build test -Doptimize=ReleaseFast -Dtest-filter='OpenAI Codex request uses'
```

Without the binary environment variables, the corresponding native cases do not
run. That is not parity verification. The native integration test uses temporary
auth files and a mock Codex service. It exercises a real fx process, a real
isolated QuickJS execution, token recovery, and native conversation resume.
It makes no paid model requests and does not read the user's credentials.

## Isolation and memory

Bun and the stock QuickJS CLI remain trusted-fixture-only choices. Their standard
modules can access files and processes. An empty environment does not remove
those capabilities.

The `quickjs-isolated` engine uses `code-worker.c`, linked against QuickJS without
quickjs-libc. The guest has no module loader, filesystem, subprocess, network,
environment, or timer APIs. Its only native callbacks send protocol messages to
the host. This is an interpreter boundary, not a kernel syscall sandbox or a
claim of protection against QuickJS vulnerabilities. The eventual T3 tool host
must validate and authorize effects independently of guest code.

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
key. This helper is not yet connected to T3 persistence. The native session
bridge accepts the key and supplies `FX_T3_PROMPT_CACHE_KEY`; the native patch
falls back to fx's own session ID when that override is absent. The integration
test verifies unchanged request bytes after token refresh and unchanged
instructions and cache identity across native session reload.

On the custom ACP path, fx uses exactly the supplied host instructions. It does
not append its default prompt, model overlays, native skill or MCP guidance,
changing date/home metadata, or a claim that question UI is unavailable. The
host is responsible for supplying its working directory, tool instructions,
and captured project context. The native integration test checks the exact
serialized instructions, not just the presence of a cache key.

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

## Codex auth ownership

Create one `makeFxCodexAuth` manager per Codex home in the environment server.
Its queue serializes rotations; concurrent callers for the same credential
operation share the result. The five-minute access-token refresh window and
eight-day fallback follow Codex's `codex-rs/login/src/auth/manager.rs`.

After a 401, the transport reloads credentials for the same account before
refreshing. It permits one refresh recovery after that reload. It does not
automatically replay successful SSE output, network failures, rate limits, or
server errors. Redirects cannot forward OAuth credentials to another origin.
Unknown refresh error bodies and transport diagnostics do not enter client
errors. Permanent refresh failures apply only to the rejected token snapshot.

Before saving a rotation, the manager re-reads the file. It keeps external token
rotations and rebases unrelated metadata edits. Private temporary files and an
atomic rename avoid partial JSON writes. This is not an interprocess atomic
compare-and-swap: Codex's current file backend does not share a lock with T3.
An external writer can still race the last comparison and rename. The manager
does not delete credentials or switch accounts to recover from that race.

A cancelled turn does not cancel a token rotation already in progress. The
manager must persist a returned refresh token before it becomes unusable.
Its OAuth request has a 30-second deadline. Await `drain()` at server shutdown.

`FxNativeSession` sets `FX_AUTH_MODE=host-managed` and gives native fx a private
loopback URL, not tokens. Native profiles live under an explicitly supplied
session-owned directory. Never pass the real user home as `nativeHome`.
The proxy buffers each outgoing request, up to 32 MiB, to support bounded 401
recovery. It streams successful responses with backpressure. This extra request
buffer is part of the future whole-process-tree memory benchmark, not the
worker-only numbers reported by `benchmark.mjs`.

## Missing before release

There is no registered T3 driver or client selection UI yet. Do not point the
prototype fixtures at the user's live credentials or T3 state.

Production integration still needs the complete Code Mode execution lifecycle,
image delivery, MCP discovery and calls, questions, approvals, custom tool
loading, and the remaining applicable bundled-extension behavior. The current
fixture host implements shell and patch calls only. Subagents remain excluded.

The eventual driver must persist fx resume state and cache identity, expose
cached-token usage, and cover provider selection, model controls, approvals,
questions, reconnects, and cancellation across web, desktop, and mobile.
Credentials and tool effects belong to the environment server, including for
remote and tunnel clients. Pi and its bundled defaults stay unchanged.
