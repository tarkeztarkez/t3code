import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "vitest";
import { makeFxCodexAuth } from "./FxCodexAuth.ts";
import { fxReserveStatus } from "./FxReserve.ts";

test("Reserve requires the current account/user banner and never redeems reset credits", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-reserve-"));
  const authDir = NodePath.join(home, ".codex");
  await NodeFSP.mkdir(authDir);
  const access =
    "header." +
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "a", chatgpt_user_id: "u" },
      }),
    ).toString("base64url") +
    ".signature";
  await NodeFSP.writeFile(
    NodePath.join(authDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: access, refresh_token: "test", account_id: "a" } }),
  );
  let data: unknown = {
    account_id: "a",
    user_id: "u",
    rate_limit_upsell: { banner_type: "luna_reserve", blocked_model_slug: "gpt-6-astra" },
  };
  const fake = async (url: string, init: RequestInit) => {
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("x-openai-codex-luna-reserve")).toBe("1");
    return Response.json(data);
  };
  const auth = makeFxCodexAuth({ homeDirectory: home, fetch: fake });
  try {
    expect(await fxReserveStatus(auth, fake, "a", "gpt-6-astra")).toMatchObject({
      entryAllowed: true,
      ordinaryUsageRecovered: false,
    });
    expect(await fxReserveStatus(auth, fake, "a", "gpt-5.4")).toMatchObject({
      entryAllowed: false,
    });
    data = {
      account_id: "other",
      user_id: "u",
      rate_limit_upsell: { banner_type: "luna_reserve" },
    };
    expect(await fxReserveStatus(auth, fake, "a", "gpt-6-astra")).toBeUndefined();
    data = { account_id: "a", user_id: "u", rate_limit: { allowed: true } };
    expect(await fxReserveStatus(auth, fake, "a", "gpt-6-astra")).toMatchObject({
      entryAllowed: false,
      ordinaryUsageRecovered: true,
    });
  } finally {
    await auth.drain();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
