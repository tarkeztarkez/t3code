# fx

fx runs a native coding agent with an OpenAI Codex subscription. Choose **fx** in
the model picker. Sign in with Codex on the environment machine first. fx reads
and refreshes `~/.codex/auth.json`; API keys are not supported. An account change
requires a new thread.

Linux and macOS environments run fx. Web, desktop and mobile clients can use
those environments, including through remote connections. The current native
runtime does not run on Windows. Windows clients can connect to a supported
environment instead.

## Tools and instructions

fx uses disposable JavaScript Code Mode. It can run commands, apply patches,
view images, update plans, ask questions and call MCP or configured custom tools.
Long executions return a cell ID that fx resumes with `wait`. Shell sessions can
continue across cells. JavaScript globals do not persist. Subagents are excluded.

fx reads `AGENTS.md`, `CLAUDE.md`, Pi instructions and skills, `.agents` skills,
and Claude skills. It honors a configured Pi agent directory. Instructions are
captured when the thread starts and reused after resume. Start a new thread to
capture changed instructions. Files that tools read still reflect current disk
contents.

MCP uses the shared and Pi-specific MCP configuration files, plus the T3 browser
tools when agent browser access is enabled. Servers connect on demand. Custom
tools use Pi's global and project-local TOML directories. fx does not enable
bundled examples automatically.

## Approvals and usage

Approval-required mode asks before command, patch, MCP and custom-tool effects.
Auto-accept edits also allows patches. Full access allows host tool effects
without prompts. Auto mode asks for approval rather than running additional paid
safety reviews. Plan mode requests approval before effects even in Full access.
An approval for the session covers only the same tool and exact input.

fx keeps the instruction prefix and cache key stable within a thread. The usage
display reports cached input tokens returned by Codex. fx does not send paid
cache keepalives or speculative requests.

If Codex authorizes Luna Reserve after quota exhaustion, fx announces the switch
and waits for your next message. Reserve is a separate limited allowance. fx
does not redeem reset credits and returns to the original model when ordinary
usage recovers.
