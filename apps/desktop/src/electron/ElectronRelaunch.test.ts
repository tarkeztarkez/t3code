import { describe, expect, it } from "vitest";

import { disableAppImageLauncherForRelaunch } from "./ElectronRelaunch.ts";

describe("ElectronRelaunch", () => {
  it("bypasses AppImageLauncher while starting a replaced AppImage", () => {
    const environment: NodeJS.ProcessEnv = {
      APPIMAGE: "/home/alice/Applications/T3-Code.AppImage",
    };

    disableAppImageLauncherForRelaunch(environment);

    expect(environment).toEqual({
      APPIMAGE: "/home/alice/Applications/T3-Code.AppImage",
      APPIMAGELAUNCHER_DISABLE: "1",
    });
  });
});
