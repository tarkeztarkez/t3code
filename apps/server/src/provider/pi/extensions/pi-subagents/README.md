# Bundled Pi subagents

T3 Code bundles this Pi extension instead of loading it from the user's `~/.pi/agent` directory.
Its state and named profiles live under T3 home:

```text
~/.t3/userdata/pi/pi-subagents/
```

Named profiles use `agents.json`:

```json
{
  "agents": [
    {
      "name": "sol-low",
      "model": "openai-codex/gpt-5.6-sol",
      "reasoning_effort": "low"
    }
  ]
}
```

The extension publishes fleet snapshots through Pi's RPC UI channel. The Pi adapter converts those snapshots to T3 `task.*` events, so child agents appear in the web and desktop Agents panel rather than a terminal-only widget.
