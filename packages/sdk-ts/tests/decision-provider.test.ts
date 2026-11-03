import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevDecisionProvider,
  JevDecisionError,
  type DecisionInput,
  type DecisionProvider,
} from "../src/decisionProvider.js";

// Transport-contract unit tests only. These fixtures are not Jev inference or quality results.
// Every test injects a mock fetch; no API key, network access, or paid call is used.
const apiKey = "test-key-do-not-log";
const candidates = [
  { id: "candidate_1", description: "The checkout button" },
  { id: "candidate_2", description: "The cancel button" },
  { id: "none", description: "No candidate satisfies the instruction" },
];

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return { instruction: "Continue to checkout", candidates, ...overrides };
}

function responseBody() {
  return {
    answers: {
      target: {
        type: "choice",
        choice: "candidate_1",
        confidence: 0.8,
        probabilities: { candidate_1: 0.8, candidate_2: 0.15, none: 0.05 },
      },
    },
    model: "jev-1.14.0",
    usage: { input_tokens: 123, output_tokens: 7 },
  };
}

function mockFetch(payload: unknown = responseBody()) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Jev decision provider mocked transport contract", () => {
  it("sends the exact bounded-choice request and reports validated response metadata", async () => {
    const fetch = mockFetch();
    const provider: DecisionProvider = createJevDecisionProvider({ apiKey, fetch });
    expect(fetch).not.toHaveBeenCalled();
    const state = { url: "https://shop.example/cart", evidence: ["Two visible buttons"] };

    const result = await provider.decide(input({ state }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: expect.any(AbortSignal),
      redirect: "error",
      credentials: "omit",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "jev-1.14.0",
      state,
      questions: {
        target: {
          type: "choice",
          instructions: "Continue to checkout",
          criteria: Object.fromEntries(candidates.map(({ id, description }) => [id, description])),
        },
      },
    });
    expect(result).toEqual({
      choice: "candidate_1",
      confidence: 0.8,
      probabilities: { candidate_1: 0.8, candidate_2: 0.15, none: 0.05 },
      model: "jev-1.14.0",
      usage: { inputTokens: 123, outputTokens: 7 },
      durationMs: expect.any(Number),
    });
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("supports a compatible HTTPS service root and requested model without inventing response metadata", async () => {
    const payload = responseBody();
    payload.model = "resolved-model-version";
    payload.usage = { input_tokens: 0, output_tokens: 0 };
    const fetch = mockFetch(payload);
    const provider = createJevDecisionProvider({
      apiKey,
      fetch,
      model: "requested-model",
      baseURL: "https://compatible.example/proxy/",
    });

    const result = await provider.decide(input());

    expect(fetch.mock.calls[0][0]).toBe("https://compatible.example/proxy/v1/systemone");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      model: "requested-model",
      state: {},
    });
    expect(result.model).toBe("resolved-model-version");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it.each(["http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"])(
    "allows an explicit loopback service root: %s",
    async (baseURL) => {
      const fetch = mockFetch();
      await createJevDecisionProvider({ apiKey, fetch, baseURL }).decide(input());
      expect(fetch.mock.calls[0][0]).toBe(`${baseURL}/v1/systemone`);
    },
  );

  it.each([
    "http://api.typesafe.ai",
    "http://localhost.example",
    "http://127.0.0.1.example",
    "ftp://localhost",
    "not-a-url",
    "https://user:password@compatible.example",
    "https://compatible.example?key=secret",
    "https://compatible.example#fragment",
  ])("rejects unsafe or ambiguous service roots before transport: %s", (baseURL) => {
    const fetch = mockFetch();
    expect(() => createJevDecisionProvider({ apiKey, fetch, baseURL })).toThrow(JevDecisionError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: "" },
    { apiKey: "   " },
    { apiKey: "line\nbreak" },
    { apiKey: "line\rbreak" },
    { model: " " },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 2_147_483_648 },
  ])("rejects invalid provider settings: %j", (settings) => {
    const fetch = mockFetch();
    expect(() => createJevDecisionProvider({ apiKey, fetch, ...settings })).toThrow(
      JevDecisionError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { instruction: "" },
    { instruction: "  " },
    { candidates: [] },
    { candidates: [{ id: "only", description: "Only choice" }] },
    { candidates: [{ id: "", description: "A choice" }, candidates[2]] },
    { candidates: [{ id: "a", description: " " }, candidates[2]] },
    {
      candidates: [
        { id: "duplicate", description: "First" },
        { id: "duplicate", description: "Second" },
      ],
    },
  ])("rejects invalid decision inputs before transport: %j", async (overrides) => {
    const fetch = mockFetch();
    await expect(
      createJevDecisionProvider({ apiKey, fetch }).decide(input(overrides)),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unserializable state without exposing its content or sending a request", async () => {
    const fetch = mockFetch();
    const state: Record<string, unknown> = { privateValue: apiKey };
    state.circular = state;
    const failure = createJevDecisionProvider({ apiKey, fetch }).decide(input({ state }));
    await expect(failure).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(failure).rejects.not.toThrow(apiKey);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an explicit none result but never adds a none candidate itself", async () => {
    const payload = responseBody();
    payload.answers.target.choice = "none";
    const fetch = mockFetch(payload);
    const provider = createJevDecisionProvider({ apiKey, fetch });
    await expect(provider.decide(input())).resolves.toMatchObject({ choice: "none" });

    await expect(
      provider.decide(input({ candidates: candidates.slice(0, 2) })),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(Object.keys(body.questions.target.criteria)).toEqual(["candidate_1", "candidate_2"]);
  });

  it("handles candidate IDs named after prototype properties without inheriting choices", async () => {
    const fetch = mockFetch({
      answers: {
        target: {
          type: "choice",
          choice: "__proto__",
          confidence: 1,
          probabilities: JSON.parse('{"__proto__":1,"constructor":0}'),
        },
      },
      model: "jev-1.14.0",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await createJevDecisionProvider({ apiKey, fetch }).decide(
      input({
        candidates: [
          { id: "__proto__", description: "First" },
          { id: "constructor", description: "Second" },
        ],
      }),
    );
    expect(Object.keys(result.probabilities)).toEqual(["__proto__", "constructor"]);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(Object.keys(body.questions.target.criteria)).toEqual(["__proto__", "constructor"]);
  });

  it.each([
    ["missing answers", {}],
    ["null response", null],
    ["array response", []],
    ["missing target", { answers: {} }],
    [
      "wrong answer type",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, type: "boolean" } },
      },
    ],
    [
      "missing answer type",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, type: undefined } },
      },
    ],
    [
      "unknown choice",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, choice: "invented" } },
      },
    ],
    [
      "prototype choice",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, choice: "toString" } },
      },
    ],
    [
      "missing confidence",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, confidence: undefined } },
      },
    ],
    [
      "negative confidence",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, confidence: -0.1 } },
      },
    ],
    [
      "confidence above one",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, confidence: 1.1 } },
      },
    ],
    [
      "string confidence",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, confidence: "0.8" } },
      },
    ],
    [
      "missing probabilities",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, probabilities: undefined } },
      },
    ],
    [
      "array probabilities",
      {
        ...responseBody(),
        answers: { target: { ...responseBody().answers.target, probabilities: [0.8, 0.15, 0.05] } },
      },
    ],
    [
      "missing candidate probability",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 0.8, none: 0.2 },
          },
        },
      },
    ],
    [
      "extra candidate probability",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 0.8, candidate_2: 0.1, none: 0.05, invented: 0.05 },
          },
        },
      },
    ],
    [
      "substituted candidate probability",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 0.8, invented: 0.15, none: 0.05 },
          },
        },
      },
    ],
    [
      "negative probability",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 1, candidate_2: 0.1, none: -0.1 },
          },
        },
      },
    ],
    [
      "probability above one",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 1.1, candidate_2: 0, none: 0 },
          },
        },
      },
    ],
    [
      "string probability",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: "0.8", candidate_2: 0.15, none: 0.05 },
          },
        },
      },
    ],
    [
      "probabilities below one",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 0.1, candidate_2: 0.1, none: 0.1 },
          },
        },
      },
    ],
    [
      "probabilities above one",
      {
        ...responseBody(),
        answers: {
          target: {
            ...responseBody().answers.target,
            probabilities: { candidate_1: 0.8, candidate_2: 0.8, none: 0.8 },
          },
        },
      },
    ],
    ["missing model", { ...responseBody(), model: undefined }],
    ["empty model", { ...responseBody(), model: " " }],
    ["missing usage", { ...responseBody(), usage: undefined }],
    ["missing input tokens", { ...responseBody(), usage: { output_tokens: 7 } }],
    ["missing output tokens", { ...responseBody(), usage: { input_tokens: 123 } }],
    ["negative token usage", { ...responseBody(), usage: { input_tokens: -1, output_tokens: 7 } }],
    [
      "fractional token usage",
      { ...responseBody(), usage: { input_tokens: 1, output_tokens: 0.5 } },
    ],
    [
      "unsafe integer token usage",
      { ...responseBody(), usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 7 } },
    ],
    ["string token usage", { ...responseBody(), usage: { input_tokens: "123", output_tokens: 7 } }],
  ])("fails closed on %s without retry or fallback", async (_, payload) => {
    const fetch = mockFetch(payload);
    await expect(
      createJevDecisionProvider({ apiKey, fetch }).decide(input()),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["confidence", "probability", "input usage", "output usage"])(
    "rejects a nonfinite %s parsed from a JSON number with an excessive exponent",
    async (field) => {
      const body = JSON.stringify(responseBody()).replace(
        field === "confidence"
          ? '"confidence":0.8'
          : field === "probability"
            ? '"candidate_1":0.8'
            : field === "input usage"
              ? '"input_tokens":123'
              : '"output_tokens":7',
        field === "confidence"
          ? '"confidence":1e999'
          : field === "probability"
            ? '"candidate_1":1e999'
            : field === "input usage"
              ? '"input_tokens":1e999'
              : '"output_tokens":1e999',
      );
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
      await expect(
        createJevDecisionProvider({ apiKey, fetch }).decide(input()),
      ).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    },
  );

  it("accepts small probability rounding errors without normalizing the evidence", async () => {
    const payload = responseBody();
    payload.answers.target.probabilities.none = 0.0501;
    const result = await createJevDecisionProvider({ apiKey, fetch: mockFetch(payload) }).decide(
      input(),
    );
    expect(result.probabilities.none).toBe(0.0501);
  });

  it.each([401, 429, 500])(
    "reports HTTP %i without retrying or exposing its response body",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(apiKey, { status }));
      const pending = createJevDecisionProvider({ apiKey, fetch }).decide(input());
      await expect(pending).rejects.toMatchObject({ code: "HTTP_ERROR", status });
      await expect(pending).rejects.not.toThrow(apiKey);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes transport errors that might contain credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`Request with ${apiKey} failed`));
    const pending = createJevDecisionProvider({ apiKey, fetch }).decide(input());
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(pending).rejects.not.toThrow(apiKey);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes invalid JSON errors without returning response content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(apiKey));
    const pending = createJevDecisionProvider({ apiKey, fetch }).decide(input());
    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(pending).rejects.not.toThrow(apiKey);
  });

  it("rejects pre-aborted requests without invoking transport", async () => {
    const fetch = mockFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createJevDecisionProvider({ apiKey, fetch }).decide(input({ signal: controller.signal })),
    ).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("detects cancellation during state serialization without invoking transport", async () => {
    const fetch = mockFetch();
    const controller = new AbortController();
    const state = {
      toJSON() {
        controller.abort();
        return {};
      },
    };
    await expect(
      createJevDecisionProvider({ apiKey, fetch }).decide(
        input({ signal: controller.signal, state }),
      ),
    ).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts pending transport and settles even if a mocked transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = createJevDecisionProvider({ apiKey, fetch }).decide(
      input({ signal: controller.signal }),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out and aborts a transport that ignores its signal without retrying", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = createJevDecisionProvider({ apiKey, fetch, timeoutMs: 100 }).decide(input());
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the deadline while reading the response body, not just until headers arrive", async () => {
    vi.useFakeTimers();
    const response = Response.json(responseBody());
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const pending = createJevDecisionProvider({ apiKey, fetch, timeoutMs: 100 }).decide(input());
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it.each(["success", "failure"])(
    "cleans up caller listeners and timers after %s",
    async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const fetch = mockFetch(outcome === "success" ? responseBody() : {});
      const pending = createJevDecisionProvider({ apiKey, fetch }).decide(
        input({ signal: controller.signal }),
      );
      if (outcome === "success") await pending;
      else await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
      expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
    },
  );

  it("isolates cancellation between simultaneous decisions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(Response.json(responseBody()));
    const controller = new AbortController();
    const provider = createJevDecisionProvider({ apiKey, fetch });
    const first = provider.decide(input({ signal: controller.signal }));
    const rejected = expect(first).rejects.toMatchObject({ code: "ABORTED" });
    const second = provider.decide(input());
    controller.abort();
    await rejected;
    await expect(second).resolves.toMatchObject({ choice: "candidate_1" });
    expect(fetch.mock.calls[1][1]!.signal!.aborted).toBe(false);
  });
});
