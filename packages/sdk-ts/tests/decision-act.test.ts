import type { SnapshotResult } from "@browserbasehq/stagehand-protocol/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDecisionCandidates,
  runDecisionAct,
  type DecisionAction,
  type DecisionActOptions,
} from "../src/decisionAct.js";
import type { DecisionInput, DecisionResult } from "../src/decisionProvider.js";
import type { Page } from "../src/page.js";

// These are mocked control-flow/unit tests, NOT live model accuracy or latency benchmarks.
const fixture: SnapshotResult = {
  formattedTree: [
    "[0-1] main: Account settings",
    "  [0-2] region: Billing",
    "    [0-3] button: Save",
    "    [0-4] textbox: Email",
    "    [0-5] select: Plan",
    "  [0-6] region: Shipping",
    "    [0-7] button: Save",
  ].join("\n"),
  xpathMap: {
    "0-1": "/html/body/main",
    "0-2": "/html/body/main/section[1]",
    "0-3": "/html/body/main/section[1]/button",
    "0-4": "/html/body/main/section[1]/input",
    "0-5": "/html/body/main/section[1]/select",
    "0-6": "/html/body/main/section[2]",
    "0-7": "/html/body/main/section[2]/button",
  },
  urlMap: {},
};

function decision(choice = "0-3", confidence = 0.95): DecisionResult {
  return {
    choice,
    confidence,
    probabilities: {
      [choice]: confidence,
      [choice === "none" ? "0-3" : "none"]: 1 - confidence,
    },
    model: "mock-unit-test-only",
    usage: { inputTokens: 40, outputTokens: 4 },
    durationMs: 2,
  };
}

function setup(snapshot: SnapshotResult = fixture) {
  const locator = {
    count: vi.fn(async (_options?: { timeout: number }) => 1),
    isVisible: vi.fn(async (_options?: { timeout: number }) => true),
    click: vi.fn(async (_options?: { timeout: number }) => {}),
    fill: vi.fn(async (_value: string, _options?: { timeout: number }) => {}),
    selectOption: vi.fn(async (values: string[], _options?: { timeout: number }) => values),
  };
  const mockPage = {
    rpcClient: {},
    pageId: "mock-page",
    snapshot: vi.fn(async (_options?: { timeout: number }) => snapshot),
    locator: vi.fn((_selector: string) => locator),
  };
  const page = mockPage as unknown as Page;
  const provider = { decide: vi.fn(async (_input: DecisionInput) => decision()) };
  const verify = vi.fn(async (_page: Page) => true);
  const options: DecisionActOptions = { provider, action: { method: "click" }, verify };
  return { page, mockPage, locator, provider, verify, options };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collectDecisionCandidates (deterministic, no model)", () => {
  it("retains region context and ranks repeated labels using the instruction", () => {
    const result = collectDecisionCandidates(fixture, "Save in Shipping", { method: "click" }, 1);
    expect(result).toEqual({
      candidates: [
        {
          id: "0-7",
          description: "button: Save (within main: Account settings > region: Shipping)",
          xpath: fixture.xpathMap["0-7"],
        },
      ],
      eligibleCount: 4,
      truncated: true,
    });
  });

  it("filters candidates by the explicit operation", () => {
    expect(
      collectDecisionCandidates(fixture, "Email", { method: "fill", value: "x" }).candidates,
    ).toMatchObject([{ id: "0-4" }]);
    expect(
      collectDecisionCandidates(fixture, "Plan", { method: "selectOption", values: ["pro"] })
        .candidates,
    ).toMatchObject([{ id: "0-5" }]);
  });

  it("keeps source order for lexical ties", () => {
    expect(
      collectDecisionCandidates(fixture, "Save", { method: "click" }).candidates.map(
        ({ id }) => id,
      ),
    ).toEqual(["0-3", "0-7", "0-4", "0-5"]);
  });

  it("excludes duplicate, unmapped, and reserved IDs", () => {
    const snapshot = {
      formattedTree: "[0-1] button: A\n[0-1] button: B\n[0-2] button: C\n[none] button: D",
      xpathMap: { "0-1": "/button", none: "/none" },
      urlMap: {},
    };
    expect(collectDecisionCandidates(snapshot, "Click", { method: "click" })).toEqual({
      candidates: [],
      eligibleCount: 0,
      truncated: false,
    });
  });

  it("requires a positive finite candidate limit", () => {
    expect(() => collectDecisionCandidates(fixture, "Save", { method: "click" }, 0)).toThrow();
    expect(() =>
      collectDecisionCandidates(fixture, "Save", { method: "click" }, Infinity),
    ).toThrow();
  });

  it("defaults to at most 24 candidates without claiming they are all eligible controls", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `0-${index}`);
    const result = collectDecisionCandidates(
      {
        formattedTree: ids.map((id) => `[${id}] button: Action`).join("\n"),
        xpathMap: Object.fromEntries(ids.map((id) => [id, `/button[@id='${id}']`])),
        urlMap: {},
      },
      "Click Action",
      { method: "click" },
    );
    expect(result.candidates).toHaveLength(24);
    expect(result.eligibleCount).toBe(30);
    expect(result.truncated).toBe(true);
  });
});

describe("runDecisionAct (mocked page and provider, not a live benchmark)", () => {
  it("sends only descriptions and IDs, revalidates, clicks once, and verifies", async () => {
    const { page, mockPage, locator, provider, verify, options } = setup();
    const result = await runDecisionAct(page, "Save billing", options);
    expect(result).toMatchObject({
      success: true,
      reason: "verified",
      actionAttempted: true,
      choice: "0-3",
      confidence: 0.95,
      candidateCounts: { eligible: 4, offered: 4 },
      provider: {
        model: "mock-unit-test-only",
        usage: { inputTokens: 40, outputTokens: 4 },
        durationMs: 2,
      },
    });
    expect(mockPage.snapshot).toHaveBeenCalledTimes(2);
    expect(provider.decide).toHaveBeenCalledTimes(1);
    const input = provider.decide.mock.calls[0][0];
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.candidates.at(-1)).toEqual({
      id: "none",
      description: "No matching actionable candidate",
    });
    expect(
      input.candidates.every(
        (candidate) => Object.keys(candidate).sort().join() === "description,id",
      ),
    ).toBe(true);
    expect(JSON.stringify(input.candidates)).not.toContain("/html");
    expect(mockPage.locator).toHaveBeenCalledWith(`xpath=${fixture.xpathMap["0-3"]}`);
    expect(locator.count).toHaveBeenCalledTimes(1);
    expect(locator.isVisible).toHaveBeenCalledTimes(1);
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledExactlyOnceWith(page);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(locator.click.mock.calls[0][0]?.timeout).toBeGreaterThan(0);
    expect(locator.click.mock.calls[0][0]?.timeout).toBeLessThanOrEqual(20_000);
  });

  it.each([
    { action: { method: "fill", value: "person@example.test" }, choice: "0-4" },
    { action: { method: "selectOption", values: ["pro"] }, choice: "0-5" },
  ] satisfies Array<{ action: DecisionAction; choice: string }>)(
    "executes explicit $action.method parameters",
    async ({ action, choice }) => {
      const { page, locator, provider, options } = setup();
      provider.decide.mockResolvedValue(decision(choice));
      const result = await runDecisionAct(page, "Update billing", { ...options, action });
      expect(result.success).toBe(true);
      if (action.method === "fill")
        expect(locator.fill).toHaveBeenCalledExactlyOnceWith(action.value, expect.any(Object));
      if (action.method === "selectOption")
        expect(locator.selectOption).toHaveBeenCalledExactlyOnceWith(
          action.values,
          expect.any(Object),
        );
      expect(locator.click).not.toHaveBeenCalled();
    },
  );

  it.each(["path", "description", "region", "missing"])(
    "rejects stale %s without an action",
    async (change) => {
      const { page, mockPage, locator, verify, options } = setup();
      const fresh = structuredClone(fixture);
      if (change === "path") fresh.xpathMap["0-3"] = "/somewhere/else";
      if (change === "description")
        fresh.formattedTree = fresh.formattedTree.replace("button: Save", "button: Delete");
      if (change === "region")
        fresh.formattedTree = fresh.formattedTree.replace("region: Billing", "region: Archived");
      if (change === "missing") delete fresh.xpathMap["0-3"];
      mockPage.snapshot.mockResolvedValueOnce(fixture).mockResolvedValueOnce(fresh);
      expect(await runDecisionAct(page, "Save", options)).toMatchObject({
        success: false,
        reason: "stale_choice",
        actionAttempted: false,
      });
      expect(locator.click).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    { choice: "unknown", confidence: 0.99, reason: "unknown_choice" },
    { choice: "none", confidence: 0.99, reason: "none" },
    { choice: "0-3", confidence: 0.79, reason: "low_confidence" },
    { choice: "0-3", confidence: NaN, reason: "invalid_decision" },
    { choice: "0-3", confidence: 1.1, reason: "invalid_decision" },
  ])("fails closed for $reason", async ({ choice, confidence, reason }) => {
    const { page, mockPage, locator, provider, verify, options } = setup();
    provider.decide.mockResolvedValue(decision(choice, confidence));
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      success: false,
      reason,
      actionAttempted: false,
    });
    expect(mockPage.snapshot).toHaveBeenCalledTimes(1);
    expect(locator.click).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("can click an input to focus or open its picker", async () => {
    const { page, locator, provider, options } = setup();
    provider.decide.mockResolvedValue(decision("0-4"));
    expect(await runDecisionAct(page, "Click the Email field", options)).toMatchObject({
      success: true,
    });
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("does not query a provider when there are no candidates", async () => {
    const { page, provider, options } = setup({
      formattedTree: "[0-1] paragraph: No controls",
      xpathMap: {},
      urlMap: {},
    });
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      success: false,
      reason: "no_candidates",
    });
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it("supports configurable confidence and candidate limits", async () => {
    const { page, provider, options } = setup();
    provider.decide.mockResolvedValue(decision("0-3", 0.6));
    expect(
      await runDecisionAct(page, "Save billing", {
        ...options,
        minConfidence: 0.6,
        maxCandidates: 1,
      }),
    ).toMatchObject({
      success: true,
      candidateCounts: { eligible: 4, offered: 1 },
    });
    expect(provider.decide.mock.calls[0][0].candidates).toHaveLength(2);
  });

  it.each([0, 2])("rejects a locator with %s matches", async (count) => {
    const { page, locator, options } = setup();
    locator.count.mockResolvedValue(count);
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      reason: "not_unique",
      success: false,
    });
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("rejects hidden targets", async () => {
    const { page, locator, options } = setup();
    locator.isVisible.mockResolvedValue(false);
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      reason: "not_visible",
      success: false,
    });
    expect(locator.click).not.toHaveBeenCalled();
  });

  it.each([false, "true"])(
    "does not report success unless verification returns true, got %s",
    async (value) => {
      const { page, locator, verify, options } = setup();
      verify.mockResolvedValue(value as boolean);
      expect(await runDecisionAct(page, "Save", options)).toMatchObject({
        success: false,
        reason: "verification_failed",
        actionAttempted: true,
      });
      expect(locator.click).toHaveBeenCalledTimes(1);
    },
  );

  it("reports verification exceptions as failures after the attempted action", async () => {
    const { page, verify, options } = setup();
    verify.mockRejectedValue(new Error("Postcondition unavailable"));
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      success: false,
      reason: "verification_failed",
      actionAttempted: true,
    });
  });

  it("does not retry actions on execution failures", async () => {
    const { page, locator, verify, options } = setup();
    locator.click.mockRejectedValue(new Error("Click response lost"));
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      success: false,
      reason: "execution_failed",
      actionAttempted: true,
    });
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("has no fallback after a provider failure", async () => {
    const { page, provider, locator, options } = setup();
    provider.decide.mockRejectedValue(new Error("Provider unavailable"));
    expect(await runDecisionAct(page, "Save", options)).toMatchObject({
      success: false,
      reason: "provider_error",
      actionAttempted: false,
    });
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("rejects invalid options before reading the page", async () => {
    const { page, mockPage, options } = setup();
    for (const invalid of [
      { verify: undefined },
      { provider: undefined },
      { action: { method: "evaluate" } },
      { action: { method: "fill" } },
      { action: { method: "selectOption", values: [123] } },
      { maxCandidates: 0 },
      { minConfidence: -1 },
      { timeout: 0 },
    ]) {
      expect(
        await runDecisionAct(page, "Save", { ...options, ...invalid } as DecisionActOptions),
      ).toMatchObject({ success: false, reason: "invalid_options" });
    }
    expect(mockPage.snapshot).not.toHaveBeenCalled();
  });

  it("uses one deadline across snapshots, the decision, and action", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { page, mockPage, locator, provider, options } = setup();
    mockPage.snapshot.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fixture;
    });
    provider.decide.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return decision();
    });
    const pending = runDecisionAct(page, "Save", { ...options, timeout: 100 });
    await vi.advanceTimersByTimeAsync(40);
    expect(await pending).toMatchObject({ success: true });
    expect(mockPage.snapshot.mock.calls.map(([options]) => options?.timeout)).toEqual([100, 70]);
    expect(locator.click.mock.calls[0][0]?.timeout).toBe(60);
  });

  it("aborts an over-deadline provider and never acts on a late answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { page, provider, locator, options } = setup();
    let resolveDecision!: (value: DecisionResult) => void;
    provider.decide.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    const pending = runDecisionAct(page, "Save", { ...options, timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({
      success: false,
      reason: "timeout",
      actionAttempted: false,
    });
    expect(provider.decide.mock.calls[0][0].signal?.aborted).toBe(true);
    resolveDecision(decision());
    await vi.advanceTimersByTimeAsync(0);
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("times out verification without claiming that execution was undone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { page, verify, options } = setup();
    verify.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    });
    const pending = runDecisionAct(page, "Save", { ...options, timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result).toMatchObject({ success: false, reason: "timeout", actionAttempted: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(result.success).toBe(false);
  });

  it("rejects concurrent wrappers for the same page until timed-out work settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { page, mockPage, locator, options } = setup();
    locator.click.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const alias = { ...mockPage } as unknown as Page;
    const pending = runDecisionAct(page, "Save", { ...options, timeout: 10 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await runDecisionAct(alias, "Save", options)).toMatchObject({
      reason: "concurrent_action",
      success: false,
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(await pending).toMatchObject({ reason: "timeout", actionAttempted: true });
    expect(await runDecisionAct(alias, "Save", options)).toMatchObject({
      reason: "concurrent_action",
    });
    await vi.advanceTimersByTimeAsync(20);
    locator.click.mockResolvedValue(undefined);
    expect(await runDecisionAct(alias, "Save", options)).toMatchObject({ success: true });
  });

  it("copies the requested action before awaiting the provider", async () => {
    const { page, provider, locator, options } = setup();
    const action: DecisionAction = { method: "fill", value: "original" };
    provider.decide.mockImplementation(async () => {
      action.value = "modified";
      return decision("0-4");
    });
    expect(await runDecisionAct(page, "Email", { ...options, action })).toMatchObject({
      success: true,
    });
    expect(locator.fill).toHaveBeenCalledExactlyOnceWith("original", expect.any(Object));
  });
});
