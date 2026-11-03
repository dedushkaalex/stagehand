/**
 * REAL inference comparison, never a mock benchmark.
 * Run from the repository root. No paid request is permitted without all of:
 * BENCHMARK_APPROVED=1, OPENAI_API_KEY, JEV_API_KEY, BASELINE_MODEL.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type {
  LLMGenerateParams,
  LLMGenerateResult,
  LLMMessageContentBlock,
} from "@browserbasehq/stagehand-protocol/types";
import { z } from "zod/v4";
import { STAGEHAND_EXTENSION_DIRECTORY_PATH } from "../src/extensionAssets.js";
import {
  createJevDecisionProvider,
  localBrowser,
  Stagehand,
  type DecisionActOptions,
  type DecisionProvider,
  type Page,
} from "../src/index.js";

type Scenario = "fixture" | "google-flights";
type Arm = "baseline" | "jev";
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
type Call = { durationMs: number; model: string; usage: Usage | null; succeeded: boolean };
type Step = {
  name: string;
  instruction: string;
  action: DecisionActOptions["action"];
  verify(page: Page): Promise<boolean>;
};
type StepRecord = {
  name: string;
  success: boolean;
  reason: string;
  wallTimeMs: number;
  providerCalls: number;
  calls: Call[];
  tokens: Usage | null;
  costUsd: number | null;
  timings?: unknown;
  evidence?: { screenshot?: string; snapshot?: string; captureErrors: string[] };
};
type ArmRecord = {
  arm: Arm;
  run: number;
  success: boolean;
  wallTimeMs: number;
  actionWallTimeMs: number;
  providerCalls: number;
  tokens: Usage | null;
  costUsd: number | null;
  steps: StepRecord[];
  reason?: string;
};
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const UPSTREAM_BASE_SHA = "9afa0952453e219f7164a0ea16cf293d3dcaddde";
const FLIGHTS_URL = "https://www.google.com/travel/flights?hl=en";
const ORIGIN_SELECTOR = 'input[aria-label="Where from?"]';
const TIMEOUT_MS = 30_000;

/** Exposed so the no-network approval gate can be checked without running a benchmark. */
export function benchmarkBlockers(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (env.BENCHMARK_APPROVED !== "1") missing.push("BENCHMARK_APPROVED must be exactly 1");
  for (const name of ["OPENAI_API_KEY", "JEV_API_KEY", "BASELINE_MODEL"]) {
    if (!env[name]?.trim()) missing.push(`${name} must be nonempty`);
  }
  return missing;
}

function requireApproval(): void {
  if (benchmarkBlockers(process.env).length) {
    throw new Error("Benchmark approval or required credentials are missing");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: tsx packages/sdk-ts/examples/decision-benchmark.ts [--scenario fixture|google-flights] [--runs 1..20] [--out path.json]\n" +
        "Requires BENCHMARK_APPROVED=1, OPENAI_API_KEY, JEV_API_KEY, and BASELINE_MODEL.\n" +
        "No API requests or browser launch occur when the gate is blocked. See docs/jev-decisions.ru.md.",
    );
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--scenario", "--runs", "--out"].includes(flag) || !args[index + 1]) {
      throw new Error("Expected --scenario, --runs, or --out followed by a value");
    }
    options.set(flag, args[index + 1]);
  }
  const scenario = options.get("--scenario") ?? "fixture";
  if (scenario !== "fixture" && scenario !== "google-flights") throw new Error("Unknown scenario");
  const runs = Number(options.get("--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs must be 1..20");
  const out = resolve(options.get("--out") ?? "stagehand-artifacts/decision-benchmark.json");
  const started = performance.now();
  const common = {
    schemaVersion: 1,
    inference: "real-only",
    scenario,
    requestedRuns: runs,
    createdAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    models: {
      baseline: process.env.BASELINE_MODEL?.trim() || null,
      jev: process.env.JEV_MODEL?.trim() || "jev-1.14.0",
    },
    pricing: {
      baseline: pricing("BASELINE"),
      jev: pricing("JEV"),
      note: "USD estimates from explicitly configured rates, not invoices; null means unknown.",
    },
    limitations: [
      "Different APIs and model tasks: original generative act versus bounded candidate decision.",
      "Wall time includes DOM work and verification. Arm wall time also includes browser setup.",
      "Fresh browser for each arm; alternating run order; no warm-up or hidden fallback.",
      "Small samples are diagnostic, not proof of general model superiority.",
      "Unknown or failed-call usage is null, never silently treated as zero.",
      ...(scenario === "google-flights"
        ? [
            "Live diagnostic only: open one English departure-airport picker. No search, login, booking, or CAPTCHA solving.",
          ]
        : []),
    ],
  };
  const blockers = benchmarkBlockers(process.env);
  if (blockers.length) {
    await save(out, { ...common, status: "blocked", blockers, providerCalls: 0, results: [] });
    process.exitCode = 2;
    return;
  }

  // Refuse to benchmark a modified baseline. decisionAct is additive; act itself
  // and its original runtime must match the pinned upstream base commit.
  let provenance: Awaited<ReturnType<typeof baselineProvenance>>;
  try {
    provenance = await baselineProvenance();
  } catch {
    await save(out, {
      ...common,
      status: "blocked",
      blockers: [
        "Original act source differs from the pinned upstream base or Git provenance is unavailable",
      ],
      providerCalls: 0,
      results: [],
    });
    process.exitCode = 2;
    return;
  }
  const fixture = scenario === "fixture" ? await startFixture() : undefined;
  const url = fixture?.url ?? FLIGHTS_URL;
  const results: ArmRecord[] = [];
  try {
    for (let run = 1; run <= runs; run += 1) {
      const order: Arm[] = run % 2 ? ["baseline", "jev"] : ["jev", "baseline"];
      for (const arm of order) {
        results.push(await runArm(arm, run, scenario, url, `${out}.evidence`));
        // Preserve completed work even if the following arm is interrupted.
        await save(out, {
          ...common,
          provenance,
          status: "running",
          wallTimeMs: performance.now() - started,
          results,
        });
      }
    }
  } finally {
    await fixture?.close();
  }
  const success = results.every((result) => result.success);
  await save(out, {
    ...common,
    provenance,
    status: success ? "completed" : "completed-with-failures",
    wallTimeMs: performance.now() - started,
    results,
    summary: Object.fromEntries(
      (["baseline", "jev"] as const).map((arm) => {
        const records = results.filter((record) => record.arm === arm);
        const successful = records.filter((record) => record.success);
        return [
          arm,
          {
            runs: records.length,
            successes: successful.length,
            successRate: successful.length / records.length,
            meanAllRunsActionWallTimeMs:
              records.reduce((sum, record) => sum + record.actionWallTimeMs, 0) / records.length,
            meanSuccessfulActionWallTimeMs: successful.length
              ? successful.reduce((sum, record) => sum + record.actionWallTimeMs, 0) /
                successful.length
              : null,
            completedStepCounts: records.map((record) => ({
              run: record.run,
              attempted: record.steps.length,
              verified: record.steps.filter((step) => step.success).length,
            })),
            providerCalls: records.reduce((sum, record) => sum + record.providerCalls, 0),
            tokens: totalUsage(records.map((record) => record.tokens)),
            costUsd: sumKnown(records.map((record) => record.costUsd)),
          },
        ];
      }),
    ),
  });
  if (!success) process.exitCode = 1;
}

async function runArm(
  arm: Arm,
  run: number,
  scenario: Scenario,
  url: string,
  evidenceDir: string,
): Promise<ArmRecord> {
  requireApproval();
  const started = performance.now();
  const steps: StepRecord[] = [];
  const calls: Call[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const controller = new AbortController();
  const generate =
    arm === "baseline" ? openAIGenerator(calls, scenario, controller.signal) : undefined;
  let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
  let stagehand: Stagehand | undefined;
  let failure: string | undefined;
  try {
    browser = await localBrowser.launch({ headless: true, locale: "en-US" });
    stagehand = await Stagehand.create({
      browser,
      ...(generate
        ? {
            model: {
              generate: (params: LLMGenerateParams) => trackCall(inFlight, () => generate(params)),
            },
          }
        : {}),
      logging: { level: "off" },
    });
    const page =
      (await stagehand.browser.context.pages())[0] ?? (await stagehand.browser.context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    if (scenario === "google-flights") await assertSafeFlightsPage(page);
    const realProvider = trackedJevProvider(calls, scenario);
    const provider: DecisionProvider = {
      decide: (input) => trackCall(inFlight, () => realProvider.decide(input)),
    };
    for (const step of scenarioSteps(scenario)) {
      const callOffset = calls.length;
      const stepStarted = performance.now();
      let success = false;
      let reason = "unknown";
      let timings: unknown;
      try {
        requireApproval();
        if (arm === "baseline") {
          const result = await stagehand.act(step.instruction, {
            page,
            timeout: TIMEOUT_MS,
            cache: false,
            ...(scenario === "google-flights" ? { locator: page.locator(ORIGIN_SELECTOR) } : {}),
          });
          // API success and a semantic postcondition are both required.
          success = result.data.success && (await step.verify(page));
          reason = success ? "verified" : "action-or-postcondition-failed";
        } else {
          const result = await stagehand.decisionAct(step.instruction, {
            page,
            provider,
            action: step.action,
            verify: (currentPage) => step.verify(currentPage),
            maxCandidates: 24,
            minConfidence: 0.8,
            timeout: TIMEOUT_MS,
          });
          success = result.success;
          reason = result.reason;
          timings = result.timings;
        }
      } catch (error) {
        // Never persist raw provider messages, prompts, DOM, credentials, or URLs.
        reason = error instanceof Error ? `error:${error.name}` : "error:unknown";
      }
      // A timed-out act RPC may leave its model callback running. Cancel and
      // settle it before freezing usage and wall time, never serialize a pending
      // request as duration=0 or let it mutate an already written report.
      if (!success) controller.abort();
      await Promise.allSettled(inFlight);
      const stepCalls = calls.slice(callOffset);
      const tokens = totalUsage(stepCalls.map((call) => call.usage));
      const wallTimeMs = performance.now() - stepStarted;
      const evidence = success
        ? undefined
        : await captureFailure(page, resolve(evidenceDir, `${run}-${arm}-${step.name}`));
      steps.push({
        name: step.name,
        success,
        reason,
        wallTimeMs,
        providerCalls: stepCalls.length,
        calls: stepCalls,
        tokens,
        costUsd: estimateCost(arm, stepCalls),
        ...(timings ? { timings } : {}),
        ...(evidence ? { evidence } : {}),
      });
      if (!success) break; // No retry, guessed alternative, or LLM fallback.
    }
  } catch (error) {
    failure =
      error instanceof Error
        ? `setup:${error.message.replace(/[^a-zA-Z0-9 :?.-]/g, "").slice(0, 160)}`
        : "setup:unknown";
    // Setup failures can contain transport details; persist only known diagnoses.
    if (!failure.startsWith("setup:Flights preflight:")) failure = "setup-failed";
  } finally {
    controller.abort();
    await Promise.allSettled(inFlight);
    try {
      await stagehand?.close();
    } catch {
      failure ??= "stagehand-cleanup-failed";
    }
    try {
      await browser?.close();
    } catch {
      failure ??= "browser-cleanup-failed";
    }
  }
  return {
    arm,
    run,
    success:
      !failure &&
      steps.length === scenarioSteps(scenario).length &&
      steps.every((step) => step.success),
    wallTimeMs: performance.now() - started,
    actionWallTimeMs: steps.reduce((sum, step) => sum + step.wallTimeMs, 0),
    providerCalls: calls.length,
    tokens: totalUsage(calls.map((call) => call.usage)),
    costUsd: estimateCost(arm, calls),
    steps,
    ...(failure ? { reason: failure } : {}),
  };
}

function openAIGenerator(calls: Call[], scenario: Scenario, signal: AbortSignal) {
  requireApproval();
  const model = process.env.BASELINE_MODEL!.trim();
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });
  return async (params: LLMGenerateParams): Promise<LLMGenerateResult> => {
    requireApproval();
    signal.throwIfAborted();
    if (params.responseFormat?.type !== "json_schema")
      throw new TypeError("Unsupported baseline response format");
    const schema = params.responseFormat.schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new TypeError("Invalid baseline schema");
    const input: ResponseInput = params.messages.map((message) => ({
      role: message.role,
      content: messageText(message.content),
    }));
    let flightsTarget: string | undefined;
    if (scenario === "google-flights") {
      if (calls.length !== 0 || params.responseFormat.name !== "Act")
        throw new Error("Flights permits one Act inference only");
      const prompt = params.messages.map((message) => messageText(message.content)).join("\n");
      const matches = [
        ...prompt.matchAll(
          /^\s*\[(\d+-\d+)\]\s+(?:combobox|textbox|input|searchbox):\s*Where from\?(?:\s.*)?$/gm,
        ),
      ];
      if (matches.length !== 1)
        throw new Error("Flights prompt lacks a unique scoped origin target");
      flightsTarget = matches[0][1];
    }
    const call: Call = { durationMs: 0, model, usage: null, succeeded: false };
    calls.push(call);
    const start = performance.now();
    try {
      const response = await client.responses.create(
        {
          model,
          instructions: params.systemPrompt,
          input,
          ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
          text: {
            format: { type: "json_schema", name: params.responseFormat.name, schema, strict: true },
          },
        },
        { signal },
      );
      call.model = response.model;
      if (response.usage) {
        call.usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
        };
      }
      const structuredContent = z.json().parse(JSON.parse(response.output_text));
      if (flightsTarget) {
        // Reject rather than rewrite: preserve the original act planning result
        // while enforcing the live diagnostic's one-click authorization.
        const allowed = z
          .object({
            action: z
              .object({
                elementId: z.literal(flightsTarget),
                description: z.string(),
                method: z.literal("click"),
                arguments: z.tuple([]),
              })
              .strict(),
            twoStep: z.literal(false),
          })
          .strict();
        allowed.parse(structuredContent);
      }
      signal.throwIfAborted();
      call.succeeded = true;
      return {
        role: "assistant",
        content: { type: "text", text: response.output_text },
        outputFormat: "json_schema",
        structuredContent,
        ...(call.usage
          ? {
              usage: {
                ...call.usage,
                totalTokens: call.usage.inputTokens + call.usage.outputTokens,
              },
            }
          : {}),
      };
    } finally {
      call.durationMs = performance.now() - start;
    }
  };
}

function trackCall<T>(pending: Set<Promise<unknown>>, operation: () => Promise<T>): Promise<T> {
  const promise = operation();
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}

function trackedJevProvider(calls: Call[], scenario: Scenario): DecisionProvider {
  requireApproval();
  const provider = createJevDecisionProvider({
    apiKey: process.env.JEV_API_KEY!,
    ...(process.env.JEV_MODEL ? { model: process.env.JEV_MODEL } : {}),
    timeoutMs: TIMEOUT_MS,
  });
  return {
    async decide(input) {
      requireApproval();
      if (scenario === "google-flights") {
        const origin = input.candidates.filter((candidate) =>
          candidate.description.includes("Where from?"),
        );
        if (origin.length !== 1) throw new Error("Flights candidate is missing or ambiguous");
        // Both arms see only the preflight-verified origin control in this live
        // diagnostic. Abstention is preserved; no unrelated control can be chosen.
        input = {
          ...input,
          candidates: input.candidates.filter(
            (candidate) => candidate.id === origin[0].id || candidate.id === "none",
          ),
        };
      }
      const call: Call = {
        durationMs: 0,
        model: process.env.JEV_MODEL ?? "jev-1.14.0",
        usage: null,
        succeeded: false,
      };
      calls.push(call);
      const start = performance.now();
      try {
        const result = await provider.decide(input);
        call.model = result.model;
        call.usage = result.usage;
        call.succeeded = true;
        return result;
      } finally {
        call.durationMs = performance.now() - start;
      }
    },
  };
}

function scenarioSteps(scenario: Scenario): Step[] {
  if (scenario === "google-flights") {
    return [
      {
        name: "open-departure-airport-picker",
        instruction:
          'Click the "Where from?" departure airport input once to open its airport picker. Do not type, navigate, search, sign in, or interact with other controls.',
        action: { method: "click" },
        verify: async (page) => {
          try {
            await page.waitForFunction(
              () =>
                Array.from(document.querySelectorAll('[role="dialog"]')).some(
                  (dialog) =>
                    dialog.getClientRects().length > 0 &&
                    !!dialog.querySelector('input[aria-label="Where from?"]') &&
                    /where from|enter a location/i.test(dialog.textContent ?? ""),
                ),
              undefined,
              { timeout: 5_000 },
            );
            return true;
          } catch {
            return false;
          }
        },
      },
    ];
  }
  return [
    ...[
      ["destination", "Destination", "Paris"],
      ["departure", "Departure date", "2027-06-15"],
      ["return", "Return date", "2027-06-22"],
    ].map(
      ([id, label, value]): Step => ({
        name: `fill-${id}`,
        instruction: `Fill the ${label} field with ${value}.`,
        action: { method: "fill", value },
        verify: async (page) => (await page.locator(`#${id}`).inputValue()) === value,
      }),
    ),
    {
      name: "select-cabin",
      instruction: "Select Economy in the Cabin class dropdown.",
      action: { method: "selectOption", values: ["economy"] },
      verify: async (page) => (await page.locator("#cabin").inputValue()) === "economy",
    },
    {
      name: "search-and-read-results",
      instruction: "Click the Search flights button.",
      action: { method: "click" },
      verify: async (page) =>
        (await page.locator("#results").textContent()) ===
          "Search results: Paris | 2027-06-15 | 2027-06-22 | economy" &&
        (await page.locator("#search-count").textContent()) === "1",
    },
  ];
}

async function assertSafeFlightsPage(page: Page): Promise<void> {
  if (new URL(await page.url()).hostname !== "www.google.com")
    throw new Error("Flights preflight: unexpected host");
  const state = await page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0;
    return {
      blocked:
        /unusual traffic|not a robot|before you continue|sign in to continue/i.test(
          document.body.innerText,
        ) ||
        Array.from(document.querySelectorAll('iframe[src*="recaptcha"], [id*="captcha"]')).some(
          visible,
        ),
      origins: Array.from(document.querySelectorAll('input[aria-label="Where from?"]')).filter(
        visible,
      ).length,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).length,
    };
  });
  if (state.blocked)
    throw new Error("Flights preflight: consent, login, or challenge requires user action");
  if (state.origins !== 1 || state.dialogs !== 0)
    throw new Error("Flights preflight: expected unique airport field is unavailable");
}

function messageText(content: LLMMessageContentBlock | LLMMessageContentBlock[]): string {
  return (Array.isArray(content) ? content : [content])
    .map((block) => {
      if (block.type !== "text")
        throw new TypeError("Baseline benchmark supports text content only");
      return block.text;
    })
    .join("\n");
}

function pricing(prefix: "BASELINE" | "JEV") {
  const rate = (suffix: string) => {
    const raw = process.env[`${prefix}_${suffix}_USD_PER_MILLION`];
    if (!raw?.trim()) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return { input: rate("INPUT"), output: rate("OUTPUT"), cachedInput: rate("CACHED_INPUT") };
}

function estimateCost(arm: Arm, calls: Call[]): number | null {
  const rates = pricing(arm === "baseline" ? "BASELINE" : "JEV");
  if (
    rates.input === null ||
    rates.output === null ||
    calls.some((call) => !call.usage || !call.succeeded)
  )
    return null;
  if (calls.length === 0) return 0;
  let cost = 0;
  for (const call of calls) {
    const usage = call.usage!;
    const cached = usage.cachedInputTokens ?? 0;
    if (cached > 0 && rates.cachedInput === null) return null;
    cost +=
      ((usage.inputTokens - cached) * rates.input +
        usage.outputTokens * rates.output +
        cached * (rates.cachedInput ?? 0)) /
      1_000_000;
  }
  return cost;
}

function totalUsage(values: (Usage | null)[]): Usage | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Usage>(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage!.inputTokens,
      outputTokens: sum.outputTokens + usage!.outputTokens,
      cachedInputTokens: (sum.cachedInputTokens ?? 0) + (usage!.cachedInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );
}

function sumKnown(values: (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

async function baselineProvenance() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const commit = git("rev-parse", "HEAD").trim();
  git("diff", "--exit-code", UPSTREAM_BASE_SHA, "--", "packages/extension");
  const sdkPath = "packages/sdk-ts/src/stagehand.ts";
  const actMethod = (source: string) => {
    const start = source.indexOf("  async act(instruction:");
    const end = source.indexOf("  async observe(", start);
    if (start < 0 || end < 0) throw new Error("Cannot identify original act method");
    return source.slice(start, end);
  };
  const original = actMethod(git("show", `${UPSTREAM_BASE_SHA}:${sdkPath}`));
  const current = actMethod(await readFile(resolve(REPO, sdkPath), "utf8"));
  if (original !== current) throw new Error("Original act implementation was modified");
  const hashes: Record<string, string> = {
    sdkAct: createHash("sha256").update(current).digest("hex"),
  };
  for (const file of [
    "services/actService.ts",
    "inference.ts",
    "prompt.ts",
    "handlers/handlerUtils/actHandlerUtils.ts",
  ]) {
    hashes[file] = createHash("sha256")
      .update(await readFile(resolve(REPO, "packages/extension", file)))
      .digest("hex");
  }
  const extensionManifest = await readFile(
    resolve(STAGEHAND_EXTENSION_DIRECTORY_PATH, "manifest.json"),
  );
  const manifest = JSON.parse(extensionManifest.toString("utf8")) as {
    background: { service_worker: string };
  };
  const worker = await readFile(
    resolve(STAGEHAND_EXTENSION_DIRECTORY_PATH, manifest.background.service_worker),
  );
  return {
    commit,
    upstreamBaseCommit: UPSTREAM_BASE_SHA,
    baseline: "original unchanged stagehand.act at the pinned upstream base commit",
    modified: "additive decisionAct in the same checkout",
    originalActSourceVerified: true,
    loadedExtension: {
      directory: STAGEHAND_EXTENSION_DIRECTORY_PATH,
      manifestSha256: createHash("sha256").update(extensionManifest).digest("hex"),
      serviceWorkerSha256: createHash("sha256").update(worker).digest("hex"),
      sourceEquivalenceVerified: false,
    },
    hashes,
  };
}

async function save(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  console.log(`Benchmark report: ${path}`);
}

async function captureFailure(
  page: Page,
  prefix: string,
): Promise<NonNullable<StepRecord["evidence"]>> {
  const evidence: NonNullable<StepRecord["evidence"]> = { captureErrors: [] };
  try {
    await mkdir(dirname(prefix), { recursive: true, mode: 0o700 });
  } catch {
    evidence.captureErrors.push("evidence-directory-unavailable");
    return evidence;
  }
  try {
    const bytes = await page.screenshot({ timeout: 5_000 });
    await writeFile(`${prefix}.png`, bytes, { mode: 0o600 });
    evidence.screenshot = `${prefix}.png`;
  } catch {
    evidence.captureErrors.push("screenshot-unavailable");
  }
  try {
    const snapshot = await page.snapshot({ timeout: 5_000 });
    await writeFile(`${prefix}.snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    evidence.snapshot = `${prefix}.snapshot.json`;
  } catch {
    evidence.captureErrors.push("snapshot-unavailable");
  }
  return evidence;
}

async function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Decision benchmark fixture</title>
<main><h1>Flight search fixture</h1><form aria-label="Flight search" onsubmit="event.preventDefault(); searchFlights()">
<label for="destination">Destination</label><input id="destination" autocomplete="off">
<label for="departure">Departure date</label><input id="departure" placeholder="YYYY-MM-DD">
<label for="return">Return date</label><input id="return" placeholder="YYYY-MM-DD">
<label for="cabin">Cabin class</label><select id="cabin"><option value="">Choose cabin</option><option value="economy">Economy</option><option value="business">Business</option></select>
<button type="submit">Search flights</button><button type="button" disabled>Unavailable search</button><button type="button" hidden>Hidden search</button>
</form><section aria-label="Search results"><p id="results" role="status">No results yet</p></section><output id="search-count" aria-label="Search count">0</output></main>
<script>function searchFlights() { const values = ['destination','departure','return','cabin'].map(id => document.getElementById(id).value); document.getElementById('results').textContent = 'Search results: ' + values.join(' | '); const count = document.getElementById('search-count'); count.textContent = String(Number(count.textContent) + 1); }</script></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Avoid leaking environment values or request details through an SDK error.
    console.error(
      "Benchmark failed before a complete report. Check arguments, build, and local output permissions.",
    );
    process.exitCode = 1;
  });
}
