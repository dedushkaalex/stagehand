import type { SnapshotResult } from "@browserbasehq/stagehand-protocol/types";
import { abortable } from "./abort.js";
import type { DecisionProvider } from "./decisionProvider.js";
import type { Page } from "./page.js";

export type DecisionAction =
  | { method: "click" }
  | { method: "fill"; value: string }
  | { method: "selectOption"; values: string[] };

export interface DecisionActOptions {
  provider: DecisionProvider;
  action: DecisionAction;
  /** Must check the intended outcome, not merely that the action was dispatched. */
  verify: (page: Page) => Promise<boolean>;
  /** Maximum actionable candidates, excluding the reserved `none` choice. Default: 24. */
  maxCandidates?: number;
  /** Minimum confidence required to execute. Inclusive, in [0, 1]. Default: 0.8. */
  minConfidence?: number;
  /** Shared deadline for every step, in milliseconds. Must be positive. Default: 20000. */
  timeout?: number;
  state?: unknown;
}

export type DecisionActReason =
  | "verified"
  | "invalid_options"
  | "concurrent_action"
  | "no_candidates"
  | "snapshot_failed"
  | "provider_error"
  | "invalid_decision"
  | "none"
  | "unknown_choice"
  | "low_confidence"
  | "stale_choice"
  | "not_unique"
  | "not_visible"
  | "revalidation_failed"
  | "execution_failed"
  | "verification_failed"
  | "timeout";

export interface DecisionActResult {
  success: boolean;
  reason: DecisionActReason;
  /** A failure after dispatch may still have changed the page. Never retry automatically. */
  actionAttempted: boolean;
  choice?: string;
  confidence?: number;
  candidateCounts: { eligible: number; offered: number };
  timings: {
    snapshotMs: number;
    decisionMs: number;
    revalidationMs: number;
    actionMs: number;
    verificationMs: number;
    totalMs: number;
  };
  provider?: {
    model: string;
    usage: { inputTokens: number; outputTokens: number };
    durationMs: number;
  };
  error?: string;
}

export interface DecisionActCandidate {
  id: string;
  description: string;
  /** Local execution metadata. This field is never sent to the decision provider. */
  xpath: string;
}

export interface DecisionCandidateCollection {
  candidates: DecisionActCandidate[];
  eligibleCount: number;
  truncated: boolean;
}

const ACTION_ROLES: Record<DecisionAction["method"], ReadonlySet<string>> = {
  click: new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "treeitem",
    "summary",
    "textbox",
    "searchbox",
    "spinbutton",
    "combobox",
    "select",
    "listbox",
    "input",
    "textarea",
    "slider",
  ]),
  fill: new Set(["textbox", "searchbox", "spinbutton", "combobox", "input", "textarea"]),
  selectOption: new Set(["select", "listbox", "combobox"]),
};

const CONTEXT_ROLES = new Set([
  "region",
  "form",
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "dialog",
  "alertdialog",
  "group",
  "table",
  "row",
  "listitem",
  "iframe",
  "rootwebarea",
]);

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "button",
  "click",
  "field",
  "fill",
  "in",
  "into",
  "link",
  "of",
  "on",
  "option",
  "please",
  "select",
  "the",
  "to",
  "with",
]);

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Deterministic AX role filtering and lexical ranking. There is no model preselection.
 * Ancestor landmarks and regions remain in descriptions to disambiguate repeated labels.
 * Ambiguous duplicate IDs and entries without a usable XPath are excluded, not guessed.
 */
export function collectDecisionCandidates(
  snapshot: SnapshotResult,
  instruction: string,
  action: DecisionAction,
  maxCandidates = 24,
): DecisionCandidateCollection {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    throw new RangeError("maxCandidates must be a positive safe integer");
  }
  const query = [...tokens(instruction)].filter((word) => !QUERY_STOP_WORDS.has(word));
  const ancestors: Array<{ indent: number; description: string; role: string }> = [];
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  const ranked: Array<DecisionActCandidate & { score: number; order: number }> = [];

  for (const [order, line] of snapshot.formattedTree.split("\n").entries()) {
    const match = /^(\s*)\[([^\]]+)\]\s+([^\s:]+)(.*)$/.exec(line);
    if (!match) continue;
    const [, spacing, id, rawRole, tail] = match;
    const indent = spacing.length;
    const role = rawRole.toLowerCase();
    const ownDescription = `${rawRole}${tail}`.trim();
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= indent) {
      ancestors.pop();
    }
    const context = ancestors
      .filter((ancestor) => CONTEXT_ROLES.has(ancestor.role))
      .map((ancestor) => ancestor.description)
      .join(" > ");
    ancestors.push({ indent, role, description: ownDescription });

    if (ids.has(id)) duplicates.add(id);
    ids.add(id);
    if (id === "none" || !ACTION_ROLES[action.method]?.has(role)) continue;
    if (!Object.hasOwn(snapshot.xpathMap, id)) continue;
    const xpath = snapshot.xpathMap[id];
    if (typeof xpath !== "string" || !xpath.trim()) continue;

    const ownTokens = tokens(ownDescription);
    const contextTokens = tokens(context);
    const score = query.reduce(
      (sum, word) => sum + (ownTokens.has(word) ? 4 : 0) + (contextTokens.has(word) ? 1 : 0),
      0,
    );
    ranked.push({
      id,
      description: context ? `${ownDescription} (within ${context})` : ownDescription,
      xpath,
      score,
      order,
    });
  }

  const eligible = ranked.filter((candidate) => !duplicates.has(candidate.id));
  eligible.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    candidates: eligible.slice(0, maxCandidates).map(({ id, description, xpath }) => ({
      id,
      description,
      xpath,
    })),
    eligibleCount: eligible.length,
    truncated: eligible.length > maxCandidates,
  };
}

// Keying by client and page ID also covers different Page wrappers for the same session page.
const activePages = new WeakMap<object, Set<string>>();

class DecisionDeadlineError extends Error {
  constructor() {
    super("Decision action deadline exceeded");
    this.name = "DecisionDeadlineError";
  }
}

function validateOptions(instruction: string, options: DecisionActOptions): string | undefined {
  if (typeof instruction !== "string" || !instruction.trim()) return "instruction is required";
  if (!options || typeof options.provider?.decide !== "function") return "provider is required";
  if (typeof options.verify !== "function") return "verify is required";
  const action = options.action;
  if (!action || !Object.hasOwn(ACTION_ROLES, action.method)) return "Unsupported action method";
  if (action.method === "fill" && typeof action.value !== "string") {
    return "fill requires a string value";
  }
  if (
    action.method === "selectOption" &&
    (!Array.isArray(action.values) || action.values.some((value) => typeof value !== "string"))
  ) {
    return "selectOption requires string values";
  }
  const maxCandidates = options.maxCandidates ?? 24;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    return "maxCandidates must be a positive safe integer";
  }
  const minConfidence = options.minConfidence ?? 0.8;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    return "minConfidence must be a finite number in [0, 1]";
  }
  const timeout = options.timeout ?? 20_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return "timeout must be positive and at most 2147483647 milliseconds";
  }
  return undefined;
}

/**
 * Decide once, revalidate once, execute at most once, and verify the caller's postcondition.
 * There is deliberately no fallback to act() or a text-generating model, and no action retry.
 * The callback and in-flight RPC cannot be forcibly cancelled; a timeout is a failure, never
 * evidence that an already dispatched action did not execute. Keep verification read-only.
 */
export async function runDecisionAct(
  page: Page,
  instruction: string,
  options: DecisionActOptions,
): Promise<DecisionActResult> {
  const started = performance.now();
  const result: DecisionActResult = {
    success: false,
    reason: "invalid_options",
    actionAttempted: false,
    candidateCounts: { eligible: 0, offered: 0 },
    timings: {
      snapshotMs: 0,
      decisionMs: 0,
      revalidationMs: 0,
      actionMs: 0,
      verificationMs: 0,
      totalMs: 0,
    },
  };
  const finish = (reason: DecisionActReason, error?: string): DecisionActResult => {
    result.reason = reason;
    result.success = reason === "verified";
    result.timings.totalMs = performance.now() - started;
    if (error !== undefined) result.error = error;
    return result;
  };
  const validationError = validateOptions(instruction, options);
  if (validationError) return finish("invalid_options", validationError);

  const pageKey = page.rpcClient ?? page;
  const pageId = page.pageId;
  let active = activePages.get(pageKey);
  if (active?.has(pageId)) return finish("concurrent_action");
  if (!active) {
    active = new Set<string>();
    activePages.set(pageKey, active);
  }
  active.add(pageId);
  const release = () => {
    active.delete(pageId);
    if (!active.size) activePages.delete(pageKey);
  };

  // Copy action parameters before awaiting: a caller/provider cannot change the planned action.
  const action: DecisionAction =
    options.action.method === "selectOption"
      ? { method: "selectOption", values: [...options.action.values] }
      : { ...options.action };
  const verify = options.verify;
  const provider = options.provider;
  const maxCandidates = options.maxCandidates ?? 24;
  const minConfidence = options.minConfidence ?? 0.8;
  const deadline = started + (options.timeout ?? 20_000);
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const deadlineError = new DecisionDeadlineError();
  const timer = setTimeout(
    () => controller.abort(deadlineError),
    Math.max(0, deadline - performance.now()),
  );
  const remaining = (): number => {
    const left = deadline - performance.now();
    if (left <= 0 || controller.signal.aborted) {
      controller.abort(deadlineError);
      throw deadlineError;
    }
    // Never send zero: the native API interprets it as disabling timeouts.
    return Math.max(1, Math.ceil(left));
  };
  type Stage = Exclude<keyof DecisionActResult["timings"], "totalMs">;
  let stage: Stage = "snapshotMs";
  const step = async <T>(name: Stage, operation: (timeout: number) => Promise<T>): Promise<T> => {
    stage = name;
    const stepStarted = performance.now();
    remaining();
    const promise = Promise.resolve().then(() => operation(remaining()));
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    try {
      const value = await abortable(promise, controller.signal);
      remaining();
      return value;
    } finally {
      result.timings[name] += performance.now() - stepStarted;
    }
  };

  try {
    const snapshot = await step("snapshotMs", (timeout) => page.snapshot({ timeout }));
    const collection = collectDecisionCandidates(snapshot, instruction, action, maxCandidates);
    remaining();
    result.candidateCounts = {
      eligible: collection.eligibleCount,
      offered: collection.candidates.length,
    };
    if (!collection.candidates.length) return finish("no_candidates");
    const decision = await step("decisionMs", () =>
      provider.decide({
        instruction,
        candidates: [
          ...collection.candidates.map(({ id, description }) => ({ id, description })),
          { id: "none", description: "No matching actionable candidate" },
        ],
        ...(options.state !== undefined ? { state: options.state } : {}),
        signal: controller.signal,
      }),
    );
    if (
      !decision ||
      typeof decision.choice !== "string" ||
      !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 ||
      decision.confidence > 1
    ) {
      return finish("invalid_decision");
    }
    result.choice = decision.choice;
    result.confidence = decision.confidence;
    result.provider = {
      model: decision.model,
      usage: decision.usage,
      durationMs: decision.durationMs,
    };
    if (decision.choice === "none") return finish("none");
    const selected = collection.candidates.find((candidate) => candidate.id === decision.choice);
    if (!selected) return finish("unknown_choice");
    if (decision.confidence < minConfidence) return finish("low_confidence");

    const current = await step("revalidationMs", (timeout) => page.snapshot({ timeout }));
    const fresh = collectDecisionCandidates(
      current,
      instruction,
      action,
      Number.MAX_SAFE_INTEGER,
    ).candidates.find((candidate) => candidate.id === selected.id);
    remaining();
    if (!fresh || fresh.xpath !== selected.xpath || fresh.description !== selected.description) {
      return finish("stale_choice");
    }
    const locator = page.locator(`xpath=${selected.xpath}`);
    const count = await step("revalidationMs", (timeout) => locator.count({ timeout }));
    if (count !== 1) return finish("not_unique");
    const visible = await step("revalidationMs", (timeout) => locator.isVisible({ timeout }));
    if (visible !== true) return finish("not_visible");

    await step("actionMs", async (timeout) => {
      result.actionAttempted = true;
      switch (action.method) {
        case "click":
          await locator.click({ timeout });
          break;
        case "fill":
          await locator.fill(action.value, { timeout });
          break;
        case "selectOption":
          await locator.selectOption(action.values, { timeout });
          break;
      }
    });
    const verified = await step("verificationMs", () => verify(page));
    return finish(verified === true ? "verified" : "verification_failed");
  } catch (error) {
    const reason: DecisionActReason =
      controller.signal.aborted || error instanceof DecisionDeadlineError
        ? "timeout"
        : {
            snapshotMs: "snapshot_failed" as const,
            decisionMs: "provider_error" as const,
            revalidationMs: "revalidation_failed" as const,
            actionMs: "execution_failed" as const,
            verificationMs: "verification_failed" as const,
          }[stage];
    return finish(reason, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    // Do not allow a second run to overlap an RPC or callback that outlived our deadline.
    if (pending.size) void Promise.allSettled(pending).then(release);
    else release();
  }
}
