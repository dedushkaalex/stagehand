import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchmarkBlockers } from "../../examples/decision-benchmark.js";
import {
  localBrowser,
  Stagehand,
  type DecisionInput,
  type DecisionProvider,
  type DecisionResult,
  type Page,
  type StagehandBrowser,
} from "../../src/index.js";

describe("benchmark approval gate (no network)", () => {
  const ready = {
    BENCHMARK_APPROVED: "1",
    OPENAI_API_KEY: "unit-test-placeholder",
    JEV_API_KEY: "unit-test-placeholder",
    BASELINE_MODEL: "unit-test-placeholder",
  };

  it("requires explicit approval and both providers' credentials", () => {
    expect(benchmarkBlockers({})).toHaveLength(4);
    for (const name of Object.keys(ready)) {
      expect(benchmarkBlockers({ ...ready, [name]: "" })).toHaveLength(1);
    }
    expect(benchmarkBlockers({ ...ready, BENCHMARK_APPROVED: "true" })).toHaveLength(1);
    expect(benchmarkBlockers({ ...ready, JEV_API_KEY: "   " })).toHaveLength(1);
    expect(benchmarkBlockers(ready)).toEqual([]);
  });
});

// This is a browser/SDK contract test with a MOCK decision provider. It does not
// call Jev, measure inference quality, or constitute a model benchmark.
describe("decisionAct local browser fixture (MOCK provider contract, no inference)", () => {
  let server: Server | undefined;
  let url: string;
  let browser: StagehandBrowser | undefined;
  let stagehand: Stagehand | undefined;
  let page: Page;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
    url = `http://127.0.0.1:${address.port}/`;
    browser = await localBrowser.launch({ headless: true });
    // No LLM configuration is required for this independent, explicit API.
    stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
    page =
      (await stagehand.browser.context.pages())[0] ?? (await stagehand.browser.context.newPage());
  }, 45_000);

  afterAll(async () => {
    try {
      await stagehand?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        await new Promise<void>((resolve, reject) => {
          if (!server) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  it("fills labelled fields, selects an option, and verifies real search results", async () => {
    await page.goto(url);
    const requests: DecisionInput[] = [];
    const provider: DecisionProvider = {
      async decide(input) {
        requests.push(input);
        // Match only the text the real provider receives, never DOM IDs,
        // selectors, page content, hidden state, or a fixed candidate position.
        const label = input.instruction.match(/target: ([^.]+)/)?.[1];
        const matching = input.candidates.filter((candidate) =>
          label ? candidate.description.includes(label) : false,
        );
        if (matching.length !== 1) {
          throw new Error(`MOCK fixture expected exactly one described target: ${label}`);
        }
        return mockResult(input, matching[0].id);
      },
    };

    for (const [label, selector, value] of [
      ["Destination", "#destination", "Paris"],
      ["Departure date", "#departure", "2027-06-15"],
      ["Return date", "#return", "2027-06-22"],
    ]) {
      const result = await stagehand!.decisionAct(`Fill target: ${label}.`, {
        page,
        provider,
        action: { method: "fill", value },
        verify: async (current) => (await current.locator(selector).inputValue()) === value,
      });
      expect(result.success, result.reason).toBe(true);
      expect(result.actionAttempted).toBe(true);
      expect(result.provider?.model).toBe("MOCK-description-contract-only");
      expect(result.provider?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }

    const selectResult = await stagehand!.decisionAct("Select target: Cabin class.", {
      page,
      provider,
      action: { method: "selectOption", values: ["economy"] },
      verify: async (current) => (await current.locator("#cabin").inputValue()) === "economy",
    });
    expect(selectResult.success, selectResult.reason).toBe(true);

    const searchResult = await stagehand!.decisionAct("Click target: Search flights.", {
      page,
      provider,
      action: { method: "click" },
      verify: async (current) =>
        (await current.locator("#results").textContent()) ===
        "Search results: Paris | 2027-06-15 | 2027-06-22 | economy",
    });
    expect(searchResult.success, searchResult.reason).toBe(true);
    expect(await page.locator("#search-count").textContent()).toBe("1");
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.candidates.length).toBeGreaterThan(1);
      expect(request.candidates.every((candidate) => Object.keys(candidate).length === 2)).toBe(
        true,
      );
      expect(request.candidates.every((candidate) => candidate.id && candidate.description)).toBe(
        true,
      );
    }
  }, 45_000);

  it("does not call a successful click a successful task when its postcondition fails", async () => {
    await page.goto(url);
    let calls = 0;
    const result = await stagehand!.decisionAct("Click Search flights", {
      page,
      provider: {
        async decide(input) {
          calls += 1;
          const candidate = input.candidates.find((item) =>
            item.description.includes("Search flights"),
          );
          if (!candidate) throw new Error("MOCK fixture target missing");
          return mockResult(input, candidate.id);
        },
      },
      action: { method: "click" },
      verify: async () => false,
    });
    expect(result.success).toBe(false);
    expect(result.actionAttempted).toBe(true);
    expect(calls).toBe(1);
    expect(await page.locator("#search-count").textContent()).toBe("1");
  });

  it("refuses an unknown choice before touching the page", async () => {
    await page.goto(url);
    const result = await stagehand!.decisionAct("Click Search flights", {
      page,
      provider: { decide: async (input) => mockResult(input, "not-an-offered-candidate") },
      action: { method: "click" },
      verify: async () => true,
    });
    expect(result.success).toBe(false);
    expect(result.actionAttempted).toBe(false);
    expect(await page.locator("#search-count").textContent()).toBe("0");
  });
});

function mockResult(input: DecisionInput, choice: string): DecisionResult {
  return {
    choice,
    confidence: 1,
    probabilities: Object.fromEntries(
      input.candidates.map((candidate) => [candidate.id, candidate.id === choice ? 1 : 0]),
    ),
    model: "MOCK-description-contract-only",
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
  };
}

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Decision fixture</title></head>
<body><main><h1>Flight search fixture</h1>
<form aria-label="Flight search" onsubmit="event.preventDefault(); searchFlights()">
<label for="destination">Destination</label><input id="destination" autocomplete="off">
<label for="departure">Departure date</label><input id="departure" placeholder="YYYY-MM-DD">
<label for="return">Return date</label><input id="return" placeholder="YYYY-MM-DD">
<label for="cabin">Cabin class</label><select id="cabin">
<option value="">Choose cabin</option><option value="economy">Economy</option>
<option value="business">Business</option></select>
<button type="submit">Search flights</button>
<button type="button" disabled>Unavailable search</button>
<button type="button" hidden>Hidden search</button>
</form><section aria-label="Search results"><p id="results" role="status">No results yet</p></section>
<output id="search-count" aria-label="Search count">0</output></main>
<script>
function searchFlights() {
  const values = ['destination', 'departure', 'return', 'cabin'].map(id => document.getElementById(id).value);
  document.getElementById('results').textContent = 'Search results: ' + values.join(' | ');
  const count = document.getElementById('search-count');
  count.textContent = String(Number(count.textContent) + 1);
}
</script></body></html>`;
