import { describe, expect, it } from "vitest";

import { findReferencedPiSkills, parsePiCommandSkills } from "./PiSkills.ts";

describe("parsePiCommandSkills", () => {
  it("maps Pi skill commands and ignores extension commands", () => {
    expect(
      parsePiCommandSkills([
        {
          name: "skill:review-code",
          description: "Review the current change.",
          source: "skill",
          location: "project",
          path: "/workspace/.agents/skills/review-code/SKILL.md",
        },
        {
          name: "project-command",
          description: "Runs extension code.",
          source: "extension",
          path: "/workspace/.pi/extensions/project.ts",
        },
      ]),
    ).toEqual([
      {
        name: "review-code",
        description: "Review the current change.",
        shortDescription: "Review the current change.",
        path: "/workspace/.agents/skills/review-code/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("drops malformed skill entries", () => {
    expect(
      parsePiCommandSkills([
        { name: "skill:", source: "skill", path: "/tmp/SKILL.md" },
        { name: "skill:no-path", source: "skill" },
        { name: "plain", source: "skill", path: "/tmp/SKILL.md" },
      ]),
    ).toEqual([]);
  });
});

describe("findReferencedPiSkills", () => {
  it("returns each known skill mentioned in the prompt once", () => {
    const skills = [
      { name: "review", path: "/skills/review/SKILL.md", enabled: true },
      { name: "deploy", path: "/skills/deploy/SKILL.md", enabled: true },
    ];
    expect(findReferencedPiSkills("$review this, then $review again and $unknown", skills)).toEqual(
      [skills[0]],
    );
  });
});
