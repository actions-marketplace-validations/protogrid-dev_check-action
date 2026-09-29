// Tests with node's own runner: node --test
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { commandData, evaluateGate, InputError, main, md, readInputs, renderSummary, runCheck } from "./index.mjs";

const done = JSON.parse(readFileSync(new URL("./fixtures/done.json", import.meta.url), "utf8"));
const clone = () => structuredClone(done);
const env = (over = {}) => ({ INPUT_URL: "https://mcp.example.com/mcp", "INPUT_API-KEY": "pgk_abcdefgh_secret", ...over });

/** A fake API: answers from a list of [status, body, headers] and records the requests. */
function fakeApi(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    const [status, body, headers = {}] = next;
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, calls };
}

describe("readInputs", () => {
  it("reads the defaults", () => {
    const i = readInputs(env());
    assert.deepEqual(i, { url: "https://mcp.example.com/mcp", apiKey: "pgk_abcdefgh_secret", baseUrl: "https://api.protogrid.dev", minScore: null, directories: [], timeoutS: 120 });
  });
  it("parses the gate inputs", () => {
    const i = readInputs(env({ "INPUT_MIN-SCORE": "75", INPUT_DIRECTORIES: "OpenAI, claude openai", "INPUT_TIMEOUT-SECONDS": "300" }));
    assert.equal(i.minScore, 75);
    assert.deepEqual(i.directories, ["openai", "claude"]);
    assert.equal(i.timeoutS, 300);
  });
  it("refuses missing and bad inputs with a helpful message", () => {
    assert.throws(() => readInputs(env({ INPUT_URL: "" })), InputError);
    assert.throws(() => readInputs(env({ "INPUT_API-KEY": " " })), /protogrid\.dev\/account/);
    assert.throws(() => readInputs(env({ "INPUT_MIN-SCORE": "90.5" })), /min-score/);
    assert.throws(() => readInputs(env({ "INPUT_MIN-SCORE": "101" })), /min-score/);
    assert.throws(() => readInputs(env({ INPUT_DIRECTORIES: "claude,smithery" })), /smithery/);
    assert.throws(() => readInputs(env({ "INPUT_TIMEOUT-SECONDS": "5" })), /timeout-seconds/);
  });
  it("sends the key over https only, except to a local stack", () => {
    assert.throws(() => readInputs(env({ "INPUT_BASE-URL": "http://api.example.com" })), /https/);
    assert.equal(readInputs(env({ "INPUT_BASE-URL": "http://localhost:8080/" })).baseUrl, "http://localhost:8080");
  });
});

describe("evaluateGate", () => {
  it("passes an answering server by default", () => {
    assert.deepEqual(evaluateGate(done, { minScore: null, directories: [] }), { failures: [], passed: true });
  });
  it("fails a server that did not answer", () => {
    const c = clone();
    c.result.probe.outcome = "timeout";
    c.result.probe.error = "timed out";
    const g = evaluateGate(c, { minScore: null, directories: [] });
    assert.equal(g.passed, false);
    assert.equal(g.failures[0], "The server did not answer the MCP probe (outcome timeout).");
  });
  it("takes auth_required as an answer", () => {
    const c = clone();
    c.result.probe.outcome = "auth_required";
    assert.equal(evaluateGate(c, { minScore: null, directories: [] }).passed, true);
  });
  it("applies min-score, and an unscored server fails it", () => {
    assert.equal(evaluateGate(done, { minScore: 100, directories: [] }).passed, true);
    const c = clone();
    c.result.quality.score = 74;
    assert.match(evaluateGate(c, { minScore: 75, directories: [] }).failures[0], /74 is under min-score 75/);
    c.result.quality.score = null;
    assert.match(evaluateGate(c, { minScore: 75, directories: [] }).failures[0], /could not be scored/);
    assert.equal(evaluateGate(c, { minScore: null, directories: [] }).passed, true);
  });
  it("fails on blockers of the directories asked for only, never on warnings or reviews", () => {
    const c = clone();
    const openai = c.result.readiness.find((d) => d.directory === "openai");
    const [a, b, h] = openai.items.filter((i) => i.kind !== "manual");
    Object.assign(a, { status: "fail", level: "must" });
    Object.assign(b, { status: "fail", level: "should" });
    Object.assign(h, { status: "warn", kind: "heuristic" });
    assert.equal(evaluateGate(c, { minScore: null, directories: ["claude"] }).passed, true);
    const g = evaluateGate(c, { minScore: null, directories: ["openai"] });
    assert.equal(g.failures.length, 1);
    assert.ok(g.failures[0].startsWith(`${openai.name}: 1 blocker (${a.title})`));
  });
  it("fails a check that could not be completed", () => {
    assert.equal(evaluateGate({ ...done, status: "failed", result: undefined }, { minScore: null, directories: [] }).passed, false);
  });
});

describe("escaping", () => {
  it("keeps third-party text from shaping the summary", () => {
    assert.equal(md("<img src=x onerror=alert(1)> | **bold** [link](http://x)\n# heading"), "&lt;img src=x onerror=alert(1)&gt; \\| \\*\\*bold\\*\\* \\[link\\](http://x) \\# heading");
    assert.equal(md("x".repeat(400)).length, 300);
  });
  it("encodes annotation data", () => {
    assert.equal(commandData("50%\r\n::warning::x"), "50%25%0D%0A::warning::x");
  });
});

describe("renderSummary", () => {
  it("shows the score, the gate, readiness and the link", () => {
    const s = renderSummary(done, { minScore: 80, directories: ["openai"] }, { failures: [], passed: true });
    assert.match(s, /^## protogrid check: https:\/\/api\.protogrid\.dev\/mcp/);
    assert.ok(!s.includes("Why it failed"));
    assert.match(s, /^- \*\*Quality:\*\* 100 \/ 100 \(good\)$/m);
    assert.match(s, /^- \*\*Gate passed:\*\* server answers; min-score 80; no blockers for openai$/m);
    assert.match(s, /None: every applicable check passes\./);
    assert.match(s, /\| Claude directory \| 0 \| 0 \| 0 \|/);
    assert.match(s, /Up to 9 items per directory are manual/);
    assert.ok(s.includes(`[Full result on protogrid](${done.page})`));
    assert.ok(!s.includes("\u2014"));
  });
  it("lists failing checks and blockers with escaped details", () => {
    const c = clone();
    c.result.quality.checks[0] = { ...c.result.quality.checks[0], status: "fail", detail: "tool `evil|name` <b>" };
    const s = renderSummary(c, { minScore: null, directories: [] }, { failures: ["x"], passed: false });
    assert.match(s, /- \*\*Gate failed:\*\* server answers\n\n\*\*Why it failed:\*\*\n\n- x\n/);
    assert.ok(s.includes(`- **FAIL** ${c.result.quality.checks[0].id.replace(/_/g, "\\_")}: tool \\\`evil\\|name\\\` &lt;b&gt;`));
  });
});

describe("renderSummary without an MCP answer", () => {
  it("lists no checks that would read as clean", () => {
    const c = clone();
    c.result.probe.outcome = "protocol_error";
    const s = renderSummary(c, { minScore: null, directories: [] }, evaluateGate(c, { minScore: null, directories: [] }));
    assert.match(s, /No MCP answer, so nothing else could be checked\./);
    assert.ok(!s.includes("Checks not passing") && !s.includes("Directory readiness"));
    assert.ok(s.includes(`[Full result on protogrid](${c.page})`));
  });
});

describe("runCheck", () => {
  const inputs = readInputs(env());
  const quiet = () => {};
  it("asks for a fresh check with the key, then reads it until it is done", async () => {
    const pending = { ...done, status: "queued", result: undefined };
    const { fetchImpl, calls } = fakeApi([[202, pending], [200, { ...pending, status: "running" }], [200, done]]);
    const c = await runCheck(inputs, fetchImpl, quiet);
    assert.equal(c.status, "done");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /^https:\/\/api\.protogrid\.dev\/v1\/check\?wait=25$/);
    assert.deepEqual(calls[0].body, { url: "https://mcp.example.com/mcp", fresh: true });
    assert.equal(calls[0].headers.authorization, "Bearer pgk_abcdefgh_secret");
    assert.match(calls[0].headers["user-agent"], /^protogrid-check-action\//);
    assert.equal(calls[1].url, `https://api.protogrid.dev/v1/check/${done.id}?wait=25`);
  });
  it("explains refused keys, URLs and quotas", async () => {
    await assert.rejects(runCheck(inputs, fakeApi([[401, { error: "unauthorized" }]]).fetchImpl, quiet), /API key was refused/);
    await assert.rejects(runCheck(inputs, fakeApi([[400, { error: "invalid_url", message: "we never take credentials" }]]).fetchImpl, quiet), /refused: we never take credentials/);
    await assert.rejects(
      runCheck(inputs, fakeApi([[429, { error: "check_quota_exceeded", message: "This account ran its 30 checks for this hour." }, { "retry-after": "600" }]]).fetchImpl, quiet),
      /30 checks for this hour\. Try again in 10 minutes\./,
    );
  });
  it("retries network errors and 5xx, then gives up", async () => {
    const { fetchImpl, calls } = fakeApi([new TypeError("fetch failed"), [503, {}], [200, done]]);
    assert.equal((await runCheck(inputs, fetchImpl, quiet)).status, "done");
    assert.equal(calls.length, 3);
    await assert.rejects(runCheck(inputs, fakeApi([[502, {}], [502, {}], [502, {}]]).fetchImpl, quiet), /answered 502/);
  });
  it("stops at the timeout and points at the page", async () => {
    let t = 0;
    const pending = { ...done, status: "running", result: undefined };
    const answers = Array.from({ length: 10 }, () => [200, pending]);
    const fetchImpl = async () => {
      t += 30_000;
      const [s, b] = answers.shift();
      return new Response(JSON.stringify(b), { status: s });
    };
    await assert.rejects(runCheck({ ...inputs, timeoutS: 60 }, fetchImpl, quiet, () => t), /did not finish within 60 seconds.*protogrid\.dev\/check\//);
  });
});

describe("main", () => {
  it("masks the key, writes outputs and the summary, and fences third-party text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-action-"));
    const out = join(dir, "out");
    const summary = join(dir, "summary");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    const c = clone();
    c.result.quality.checks[0] = { ...c.result.quality.checks[0], status: "warn", detail: "tool ::error::pwned" };
    let log = "";
    const code = await main({ ...env({ INPUT_DIRECTORIES: "openai" }), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, fakeApi([[200, c]]).fetchImpl, (s) => (log += s));
    assert.equal(code, 0);
    assert.ok(log.startsWith("::add-mask::pgk_abcdefgh_secret\n"));
    assert.equal(log.split("pgk_abcdefgh_secret").length, 2, "the key appears only in the mask command");
    const token = /::stop-commands::([0-9a-f]{32})\n/.exec(log)[1];
    const fenced = log.slice(log.indexOf(`::stop-commands::${token}`), log.indexOf(`::${token}::`));
    assert.ok(fenced.includes("tool ::error::pwned"));
    assert.ok(!log.replace(fenced, "").includes("pwned"));
    const outputs = readFileSync(out, "utf8");
    assert.match(outputs, new RegExp(`^check-id=${done.id}$`, "m"));
    assert.match(outputs, /^score=100$/m);
    assert.match(outputs, /^openai-blockers=0$/m);
    assert.match(outputs, /^passed=true$/m);
    assert.match(readFileSync(summary, "utf8"), /\*\*Gate passed:\*\*/);
  });
  it("fails the step with an annotation", async () => {
    let log = "";
    const c = clone();
    c.result.quality.score = 50;
    const code = await main(env({ "INPUT_MIN-SCORE": "75" }), fakeApi([[200, c]]).fetchImpl, (s) => (log += s));
    assert.equal(code, 1);
    assert.match(log, /::error title=protogrid check::Quality score 50 is under min-score 75\./);
  });
  it("fails early on bad inputs without calling the API", async () => {
    let log = "";
    const api = fakeApi([]);
    assert.equal(await main({ INPUT_URL: "https://x.example.com/mcp" }, api.fetchImpl, (s) => (log += s)), 1);
    assert.equal(api.calls.length, 0);
    assert.match(log, /^::error title=protogrid check::The api-key input is required/);
  });
});
