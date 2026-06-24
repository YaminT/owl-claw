import { describe, expect, it } from "vitest";
import { allowedTransitions, assertTransition, canTransition } from "./lifecycle.js";

describe("state machine", () => {
  it("allows the documented transitions", () => {
    expect(canTransition("draft", "pending")).toBe(true);
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("running", "action")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("action", "pending")).toBe(true);
    expect(canTransition("failed", "pending")).toBe(true);
  });

  it("rejects undocumented transitions", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("draft", "done")).toBe(false);
    expect(canTransition("pending", "action")).toBe(false);
    expect(() => assertTransition("done", "running")).toThrow();
  });

  it("done is terminal", () => {
    expect(allowedTransitions("done")).toEqual([]);
  });
});
