import { afterEach, describe, expect, it } from "vitest";
import { MockTool, mockState, resetMock } from "./mock.js";
import { parseUsage, sumUsage, UNKNOWN_USAGE } from "./usage.js";
import { ToolRegistry } from "./registry.js";
import { ClaudeCodeTool } from "./claude-code.js";
import { CodexTool } from "./codex.js";

afterEach(() => resetMock());

const baseOpts = {
  model: "mock-default",
  systemPrompt: "sys",
  prompt: "do it",
  cwd: "/tmp",
  autoApprove: true,
} as const;

describe("MockTool", () => {
  it("produces deterministic output and report per role", async () => {
    const tool = new MockTool();
    const a = await tool.run({ ...baseOpts, role: "developer" });
    const b = await tool.run({ ...baseOpts, role: "developer" });
    expect(a.report).toBe(b.report);
    expect(a.report).toContain("Developer report");
    expect(a.usage?.known).toBe(true);
  });

  it("emits planner questions once when configured, then proceeds", async () => {
    mockState.plannerQuestions = ["What auth provider?"];
    const tool = new MockTool();
    const first = await tool.run({ ...baseOpts, role: "planner" });
    expect(first.questions).toEqual(["What auth provider?"]);
    const second = await tool.run({ ...baseOpts, role: "planner" });
    expect(second.questions).toBeUndefined();
    expect(second.report).toContain("Plan");
  });

  it("injects a failure for a role", async () => {
    mockState.failRole = "developer";
    const tool = new MockTool();
    await expect(tool.run({ ...baseOpts, role: "developer" })).rejects.toThrow();
  });

  it("is always available via detect", async () => {
    expect((await new MockTool().detect()).status).toBe("available");
  });
});

describe("usage parsing", () => {
  it("parses input/output/cost from output", () => {
    const u = parseUsage("input_tokens: 100 output_tokens: 42 cost: $0.01");
    expect(u).toEqual({ inputTokens: 100, outputTokens: 42, costUsd: 0.01, known: true });
  });

  it("returns unknown when no usage present", () => {
    expect(parseUsage("nothing here")).toEqual(UNKNOWN_USAGE);
  });

  it("sums usages", () => {
    const total = sumUsage([
      { inputTokens: 1, outputTokens: 2, costUsd: 0.1, known: true },
      { inputTokens: 3, outputTokens: 4, costUsd: 0.2, known: true },
    ]);
    expect(total.inputTokens).toBe(4);
    expect(total.outputTokens).toBe(6);
    expect(total.costUsd).toBeCloseTo(0.3);
  });
});

describe("health detection", () => {
  it("reports unavailable for a missing CLI", async () => {
    process.env.OWL_CLAUDE_BIN = "definitely-not-a-real-binary-xyz";
    const res = await new ClaudeCodeTool().detect();
    expect(res.status).toBe("unavailable");
    delete process.env.OWL_CLAUDE_BIN;
  });

  it("registry runs health for all tools and never throws", async () => {
    process.env.OWL_CODEX_BIN = "definitely-not-real-codex-xyz";
    const reg = new ToolRegistry();
    const health = await reg.healthAll();
    expect(health.mock.status).toBe("available");
    expect(health.codex.status).toBe("unavailable");
    expect(
      reg
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["claude-code", "codex", "mock"]);
    delete process.env.OWL_CODEX_BIN;
    void CodexTool;
  });
});
