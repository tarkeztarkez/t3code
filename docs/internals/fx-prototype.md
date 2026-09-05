# fx provider

`FxDriver` registers native fx as a Codex-subscription provider. Runtime code
lives in `apps/server/src/provider/fx`; `scripts/fx` owns pinned native builds and
the disposable Code Mode worker. Web, desktop and mobile use the shared provider
contracts for selection, model controls, approvals and questions.

The bundle includes conversion 3.0.26. Pi's execution mode and configuration
remain unchanged. fx does not load Pi's extension factory or support subagents.

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

The model sees `exec` and `wait`. JavaScript has `tools`, `text`, `image`,
`generatedImage` and `ALL_TOOLS`. Host tools cover shell sessions, patches,
images, questions, plans, MCP and configured TOML custom tools. Custom definitions
reload for each execution; their promoted instructions stay fixed for the thread.
Images remain in host storage as content-addressed files. Only opaque handles
cross the QuickJS protocol. The proxy expands them into Responses image blocks.

The driver stores the instruction snapshot, native session ID and turn history
under `stateDir/fx/<instance>/<thread-hash>`. Native profiles never use the real
home directory. Rollback restores a pre-turn native profile, with copy-on-write
copies where the filesystem supports them. On other filesystems, these backups
cost disk space proportional to saved conversation history.

## Build and verify

Use Bun for the host scripts. The repository dependencies must already be
installed. Native builds require Git, CMake and a C compiler for QuickJS, and
Zig 0.16.0 for fx. `sources.json` pins both source commits. Build directories
must not exist; the build script never resets an existing checkout.

`bun scripts/fx/prepare.mjs` builds a cached runtime under `.fx-build/runtime`
and stages it into `apps/server/dist/fx`. Server bundling runs this step too.
Set `T3_BUILD_FX=1` to fail when native tooling is missing. Desktop packaging
unpacks executables and worker source from asar. macOS builds contain both Intel
and Apple Silicon executables. The fork release job installs pinned Zig.

The pinned fx source does not compile for native Windows. A cross-compile check
found POSIX-specific handles and permissions, among other errors. Windows builds
do not advertise an installed native fx runtime. Windows clients can connect to
a Linux or macOS environment. Do not substitute the unsafe Bun fixture worker.

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
claim of protection against QuickJS vulnerabilities. The T3 host validates tool
inputs and requests approval before effects when the runtime mode requires it.
Auto mode conservatively requests approval rather than purchasing extra safety
review turns; the session emits a visible warning about that policy. Session
grants authorize only the same tool and exact input, and expire when it closes.

The parent enforces a deadline, a 64 KiB source limit, 1 MiB message and output
limits, and at most 64 pending tool calls. QuickJS also has a 32 MiB engine heap
limit, a 1 MiB stack limit and a five-second CPU budget per cell. Long host calls
do not spend that CPU budget on POSIX hosts. Native delivery caps printed text
at 60 KiB; agents should filter large results before printing. These are not
whole-process memory limits. Bun
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

## Conversion 3.0.26 compatibility

- Astra and the other supported Lite models use the extension's namespace
  helpers. Host policy occupies developer-role input. Encrypted reasoning and
  cache identity survive effort changes. Optional arguments remain optional.
- A complete terminal SSE record without its final separator still reaches the
  native parser. Partial or failed streams do not trigger a host replay.
- Codex model overrides from the Pi agent directory's `models.json` survive
  catalog refresh. Endpoint and credential overrides cannot redirect fx auth.
- Quota exhaustion can select Luna Reserve only after an account/user-matched
  backend banner authorizes it. The user must send another message to continue.
  fx never redeems reset credits. It records the original model and effort and
  restores them after ordinary usage recovers, including after resume.
- Notebook metadata, voice, Shepherdr and third-party Pi extension message hooks
  have no fx lifecycle. fx does not enable those systems or their optional
  no-summary and automatic-effort experiments. Code Mode remains disposable.

The native integration tests cover host auth, approvals, cancellation, resumed
context, rollback and text generation. MCP tests use a local fixture server.
All auth tests use temporary credentials and mocked upstream responses. Do not
point tests at live credentials or the developer's T3 database. Browser and
device verification require explicit permission.
