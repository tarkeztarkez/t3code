# Bundled Pi subagents

T3 Code bundles this Pi extension instead of loading it from the user's `~/.pi/agent` directory.
Its state and named profiles live under T3 home:

```text
~/.t3/userdata/pi/pi-subagents/
```

The extension includes low, medium, and high reasoning profiles for the `sol`, `terra`, and `luna` OpenAI models. Add profiles or override those defaults with `agents.json`:

```json
{
  "agents": [
    {
      "name": "my-agent",
      "model": "openrouter/moonshotai/kimi-k3",
      "reasoning_effort": "medium"
    }
  ]
}
```

The extension publishes fleet snapshots through Pi's RPC UI channel. The Pi adapter converts those snapshots to T3 `task.*` events, so child agents appear in the web and desktop Agents panel rather than a terminal-only widget.
