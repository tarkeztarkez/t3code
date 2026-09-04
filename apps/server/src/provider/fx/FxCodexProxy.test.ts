import { describe, expect, it, vi } from "vitest";

import { FxCodexAuthError } from "./FxCodexAuth.ts";
import { openFxCodexProxy } from "./FxCodexProxy.ts";

describe("fx private Codex proxy", () => {
  it("streams before completion and aborts upstream when the native client disconnects", async () => {
    const aborted = Promise.withResolvers<void>();
    const proxy = await openFxCodexProxy({
      models: async () => Response.json({ models: [] }),
      responses: async ({ signal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
              signal?.addEventListener(
                "abort",
                () => {
                  aborted.resolve();
                  controller.error(new Error("cancelled"));
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "{}" });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n");
      await reader.cancel();
      await aborted.promise;
    } finally {
      await proxy.close();
    }
  });
  it("binds loopback, rejects unknown capabilities and methods, and forwards version parameters", async () => {
    const models = vi.fn(async () => Response.json({ models: [] }));
    const responses = vi.fn(async () => new Response("ok"));
    const proxy = await openFxCodexProxy({ models, responses });
    try {
      const url = new URL(proxy.baseUrl);
      expect(url.hostname).toBe("127.0.0.1");
      expect((await fetch(`${url.origin}/wrong/models`)).status).toBe(404);
      expect((await fetch(`${proxy.baseUrl}/responses`)).status).toBe(405);
      expect(models).not.toHaveBeenCalled();
      expect(responses).not.toHaveBeenCalled();
      expect((await fetch(`${proxy.baseUrl}/models?client_version=1.2.3`)).status).toBe(200);
      expect(models).toHaveBeenCalledWith(expect.objectContaining({ clientVersion: "1.2.3" }));
    } finally {
      await proxy.close();
      await proxy.close();
    }
  });

  it("rejects oversized request bodies before calling Codex", async () => {
    const responses = vi.fn(async () => new Response("ok"));
    const proxy = await openFxCodexProxy({
      models: async () => Response.json({ models: [] }),
      responses,
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        body: "x".repeat(33 * 1024 * 1024),
      });
      expect(response.status).toBe(413);
      expect(responses).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it("redacts unexpected transport errors and exposes actionable auth failures", async () => {
    let error: Error = new Error("private upstream secret");
    const proxy = await openFxCodexProxy({
      models: async () => Response.json({ models: [] }),
      responses: async () => {
        throw error;
      },
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "{}" });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private upstream secret");
      error = new FxCodexAuthError("account_changed");
      const changed = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "{}" });
      expect(changed.status).toBe(401);
      expect(await changed.text()).toContain("account changed");
    } finally {
      await proxy.close();
    }
  });
});
