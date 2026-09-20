import { describe, expect, it } from "bun:test";

import type { Project } from "../../src/t3/contracts/orchestration.ts";
import type { Provider } from "../../src/t3/contracts/providers.ts";
import type { VcsRef } from "../../src/t3/contracts/vcs.ts";
import {
  resolveHarness,
  resolveModel,
  resolveProject,
  resolveWorktree,
  unusableReason,
} from "../../src/t3/selection.ts";

const projects = [
  { id: "p1", title: "app", workspaceRoot: "/workspace/app", defaultModelSelection: null },
  { id: "p2", title: "app", workspaceRoot: "C:\\code\\App\\", defaultModelSelection: null },
  { id: "p3", title: "lib", workspaceRoot: "/workspace/lib", defaultModelSelection: null },
] satisfies [Project, Project, Project];

describe("resolveProject", () => {
  it("matches id, then normalized workspace root, then exact title", () => {
    expect(resolveProject(projects, "p3").id).toBe("p3");
    expect(resolveProject(projects, "c:/code/app").id).toBe("p2");
    expect(resolveProject(projects, "/workspace/app/").id).toBe("p1");
    expect(resolveProject(projects, "lib").id).toBe("p3");
  });

  it("refuses ambiguous titles and lists what it knows for misses", () => {
    expect(() => resolveProject(projects, "app")).toThrow(/ambiguous.*p1.*p2/);
    expect(() => resolveProject(projects, "nope")).toThrow(/not found.*app \[p1\].*lib \[p3\]/);
    expect(() => resolveProject(projects, "  ")).toThrow(/required/);
  });
});

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  instanceId: "testHarness",
  driver: "testHarness",
  displayName: "Test Harness",
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    { slug: "model-large", name: "Large Model", aliases: ["large"] },
    { slug: "model-small", name: "Small Model", aliases: ["small"] },
  ],
  ...overrides,
});

describe("unusableReason", () => {
  it("explains every way a harness can be unusable", () => {
    expect(unusableReason(provider())).toBeNull();
    expect(
      unusableReason(
        provider({ availability: "unavailable", unavailableReason: "binary missing" }),
      ),
    ).toBe("binary missing");
    expect(unusableReason(provider({ installed: false }))).toBe("not installed");
    expect(unusableReason(provider({ enabled: false }))).toBe("disabled in T3 settings");
    expect(unusableReason(provider({ status: "disabled", message: "turned off" }))).toBe(
      "turned off",
    );
    expect(unusableReason(provider({ auth: { status: "unauthenticated" } }))).toMatch(
      /not signed in/,
    );
  });
});

describe("resolveHarness", () => {
  const providers = [
    provider(),
    provider({
      instanceId: "missingHarness",
      driver: "missingHarness",
      displayName: "Missing Harness",
      installed: false,
    }),
  ];

  it("matches instance id exactly, or display name / driver case-insensitively", () => {
    expect(resolveHarness(providers, "testHarness").instanceId).toBe("testHarness");
    expect(resolveHarness(providers, "test harness").instanceId).toBe("testHarness");
  });

  it("rejects unknown and unusable harnesses with the valid ids", () => {
    expect(() => resolveHarness(providers, "unknownHarness")).toThrow(
      /not found.*testHarness, missingHarness/,
    );
    expect(() => resolveHarness(providers, "missingHarness")).toThrow(
      /not usable right now: not installed/,
    );
  });
});

describe("resolveModel", () => {
  it("matches slug, alias, or display name and lists offered slugs on a miss", () => {
    expect(resolveModel(provider(), "model-small").slug).toBe("model-small");
    expect(resolveModel(provider(), "large").slug).toBe("model-large");
    expect(resolveModel(provider(), "Small Model").slug).toBe("model-small");
    expect(() => resolveModel(provider(), "unknown-model")).toThrow(
      /not offered by harness "testHarness".*model-large, model-small/,
    );
  });
});

describe("resolveWorktree", () => {
  const project = projects[0];
  const refs: VcsRef[] = [
    { name: "main", current: true, isDefault: true, worktreePath: "/workspace/app" },
    { name: "feat", current: false, isDefault: false, worktreePath: "/workspace/app-feat" },
    { name: "origin/main", current: false, isDefault: false, isRemote: true, worktreePath: null },
  ];

  it("maps the project root to the main checkout and known worktrees to their branch", () => {
    expect(resolveWorktree(project, refs, "/workspace/app/")).toEqual({
      branch: "main",
      worktreePath: null,
    });
    expect(resolveWorktree(project, refs, "/WORKSPACE/app-feat")).toEqual({
      branch: "feat",
      worktreePath: "/workspace/app-feat",
    });
  });

  it("rejects paths T3 does not know as worktrees", () => {
    expect(() => resolveWorktree(project, refs, "/tmp/elsewhere")).toThrow(
      /not a worktree of project "app".*app-feat \(feat\)/,
    );
    expect(() => resolveWorktree(project, [], "/tmp/elsewhere")).toThrow(
      /none besides the project root/,
    );
  });
});
