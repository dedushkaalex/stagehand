/** A named alternative in a bounded decision. Include an explicit abstention choice if needed. */
export interface DecisionCandidate {
  id: string;
  description: string;
}

export interface DecisionInput {
  instruction: string;
  /** At least two allowed choices; the provider does not add or invent candidates. */
  candidates: DecisionCandidate[];
  state?: unknown;
  signal?: AbortSignal;
}

export interface DecisionResult {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

/** A provider-neutral interface for choosing among explicitly supplied alternatives. */
export interface DecisionProvider {
  decide(input: DecisionInput): Promise<DecisionResult>;
}

export interface JevDecisionProviderOptions {
  apiKey: string;
  /** Defaults to jev-1.14.0. */
  model?: string;
  /** Service root, without /v1/systemone. HTTP is allowed only for explicit loopback hosts. */
  baseURL?: string;
  /** Injectable transport for testing or an API-compatible service. */
  fetch?: typeof globalThis.fetch;
  /** Deadline covering the request and response body. Defaults to 30,000 milliseconds. */
  timeoutMs?: number;
}

export type JevDecisionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED";

/** Errors never include API keys, request state, response bodies, or transport error details. */
export class JevDecisionError extends Error {
  readonly code: JevDecisionErrorCode;
  readonly status?: number;

  constructor(message: string, code: JevDecisionErrorCode, status?: number) {
    super(message);
    this.name = "JevDecisionError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_MODEL = "jev-1.14.0";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
// Allow small rounding differences, but never normalize or invent probabilities.
const PROBABILITY_SUM_TOLERANCE = 0.001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidInput(message: string): never {
  throw new JevDecisionError(message, "INVALID_INPUT");
}

function invalidResponse(message: string): never {
  throw new JevDecisionError(message, "INVALID_RESPONSE");
}

function endpointFor(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return invalidInput("Jev baseURL must be a valid absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    invalidInput("Jev baseURL requires HTTPS except for explicit loopback hosts");
  }
  if (url.username || url.password || url.search || url.hash) {
    invalidInput("Jev baseURL must not contain credentials, query parameters, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/systemone`;
  return url.toString();
}

function requestBody(
  input: DecisionInput,
  model: string,
): {
  body: string;
  candidateIDs: Set<string>;
} {
  if (!input || !isNonemptyString(input.instruction)) {
    invalidInput("Jev decision instruction must be a nonempty string");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length < 2) {
    invalidInput("Jev decision requires at least two candidates");
  }
  const candidateIDs = new Set<string>();
  const criteria: Record<string, string> = Object.create(null);
  for (const candidate of input.candidates) {
    if (!candidate || !isNonemptyString(candidate.id) || !isNonemptyString(candidate.description)) {
      invalidInput("Jev candidates must have nonempty string IDs and descriptions");
    }
    if (candidateIDs.has(candidate.id)) {
      invalidInput("Jev candidate IDs must be unique");
    }
    candidateIDs.add(candidate.id);
    criteria[candidate.id] = candidate.description;
  }
  try {
    return {
      body: JSON.stringify({
        model,
        state: input.state === undefined ? {} : input.state,
        questions: {
          target: { type: "choice", instructions: input.instruction, criteria },
        },
      }),
      candidateIDs,
    };
  } catch {
    return invalidInput("Jev decision state must be JSON serializable");
  }
}

function parseResponse(
  payload: unknown,
  candidateIDs: Set<string>,
  durationMs: number,
): DecisionResult {
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.target)) {
    invalidResponse("Jev response must contain answers.target");
  }
  const target = payload.answers.target;
  if (target.type !== "choice") {
    invalidResponse("Jev response target must be a choice answer");
  }
  if (typeof target.choice !== "string" || !candidateIDs.has(target.choice)) {
    invalidResponse("Jev response choice must be one of the supplied candidates");
  }
  if (
    typeof target.confidence !== "number" ||
    !Number.isFinite(target.confidence) ||
    target.confidence < 0 ||
    target.confidence > 1
  ) {
    invalidResponse("Jev response confidence must be a finite number between 0 and 1");
  }
  if (!isRecord(target.probabilities)) {
    invalidResponse("Jev response must contain probabilities for every supplied candidate");
  }
  const entries = Object.entries(target.probabilities);
  if (entries.length !== candidateIDs.size) {
    invalidResponse("Jev response probabilities must match the supplied candidates exactly");
  }
  let sum = 0;
  for (const [id, probability] of entries) {
    if (!candidateIDs.has(id)) {
      invalidResponse("Jev response probabilities must match the supplied candidates exactly");
    }
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      invalidResponse("Jev response probabilities must be finite numbers between 0 and 1");
    }
    sum += probability;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    invalidResponse("Jev response probabilities must sum to 1 within 0.001");
  }
  if (!isNonemptyString(payload.model)) {
    invalidResponse("Jev response must include the actual model");
  }
  if (
    !isRecord(payload.usage) ||
    !Number.isSafeInteger(payload.usage.input_tokens) ||
    (payload.usage.input_tokens as number) < 0 ||
    !Number.isSafeInteger(payload.usage.output_tokens) ||
    (payload.usage.output_tokens as number) < 0
  ) {
    invalidResponse("Jev response must include nonnegative integer input and output token usage");
  }
  return {
    choice: target.choice,
    confidence: target.confidence,
    probabilities: Object.fromEntries(entries) as Record<string, number>,
    model: payload.model,
    usage: {
      inputTokens: payload.usage.input_tokens as number,
      outputTokens: payload.usage.output_tokens as number,
    },
    durationMs,
  };
}

/**
 * Calls the Jev System One choice API once per decision, with no retries or fallback.
 * All tests can supply a mocked fetch; creating a provider itself makes no requests.
 */
export function createJevDecisionProvider(options: JevDecisionProviderOptions): DecisionProvider {
  if (!options || !isNonemptyString(options.apiKey) || /[\r\n]/.test(options.apiKey)) {
    invalidInput("Jev apiKey must be a nonempty string without line breaks");
  }
  const model = options.model ?? DEFAULT_MODEL;
  if (!isNonemptyString(model)) invalidInput("Jev model must be a nonempty string");
  const endpoint = endpointFor(options.baseURL ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    invalidInput("Jev timeoutMs must be positive and at most 2147483647 milliseconds");
  }
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") invalidInput("Jev requires a fetch implementation");
  const apiKey = options.apiKey;

  return {
    async decide(input): Promise<DecisionResult> {
      const signal = input?.signal;
      if (signal?.aborted) {
        throw new JevDecisionError("Jev decision request aborted", "ABORTED");
      }
      const { body, candidateIDs } = requestBody(input, model);
      if (signal?.aborted) {
        throw new JevDecisionError("Jev decision request aborted", "ABORTED");
      }
      const controller = new AbortController();
      const onCallerAbort = () => {
        controller.abort(new JevDecisionError("Jev decision request aborted", "ABORTED"));
      };
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timeout = setTimeout(() => {
        controller.abort(new JevDecisionError("Jev decision request timed out", "TIMEOUT"));
      }, timeoutMs);
      const started = performance.now();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const operation = (async () => {
          let response: Response;
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body,
              signal: controller.signal,
              redirect: "error",
              credentials: "omit",
            });
          } catch {
            throw new JevDecisionError("Jev decision request failed", "NETWORK_ERROR");
          }
          if (!response.ok) {
            // Release an unused error body without reading or exposing its contents.
            void response.body?.cancel().catch(() => {});
            throw new JevDecisionError(
              `Jev decision request returned HTTP ${response.status}`,
              "HTTP_ERROR",
              response.status,
            );
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            invalidResponse("Jev response body must be valid JSON");
          }
          return parseResponse(payload, candidateIDs, Math.max(0, performance.now() - started));
        })();
        return await Promise.race([operation, aborted]);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onCallerAbort);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
