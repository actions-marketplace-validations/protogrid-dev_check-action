// @ts-check
/**
 * protogrid MCP server check, as a GitHub Action step.
 *
 * Runs protogrid's on-demand check against the public URL of a remote MCP server (one credential-free,
 * read-only probe: protocol, authorization metadata, tool hygiene and the readiness for the Claude and
 * OpenAI directories), writes the result to the job summary and fails the step when the gate is not met.
 * One file, no dependencies: everything this action runs is below.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERSION = "1.0.0";
const USER_AGENT = `protogrid-check-action/${VERSION} (+https://github.com/protogrid-dev/check-action)`;
/** Longest the API holds one request open. */
const MAX_WAIT_S = 25;
const DIRECTORY_IDS = ["claude", "openai"];
/** Probe outcomes of a server that answered (an OAuth server answers 401, which is fine). */
const ANSWERED = ["ok", "auth_required"];

/**
 * @typedef {{ url: string; apiKey: string; baseUrl: string; minScore: number | null; directories: string[]; timeoutS: number }} Inputs
 * @typedef {{ id: string; category: string; status: string; detail: string }} QualityCheck
 * @typedef {{ id: string; title: string; level: string; kind: string; status: string; detail: string }} ReadinessItem
 * @typedef {{ directory: string; name: string; items: ReadinessItem[]; summary: { blockers: number; warnings: number; review: number; unknown: number; manual: number } }} Readiness
 * @typedef {{ id: string; status: string; url: string; page: string; server: string | null; error?: string; result?: { checked_at: string; probe: { outcome: string; error: string | null; protocol: { versions: string[] } }; quality: { score: number | null; label: string; components: Record<string, number | null>; checks: QualityCheck[]; tool_count: number; token_estimate: number | null }; readiness: Readiness[] } }} Check
 */

export class InputError extends Error {}

/** Reads and validates the inputs GitHub passes as INPUT_<NAME> variables. */
export function readInputs(env) {
  const get = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const url = get("url");
  if (!url) throw new InputError("The url input is required: the public URL of your remote MCP server, for example https://mcp.example.com/mcp.");
  const apiKey = get("api-key");
  if (!apiKey) {
    throw new InputError(
      "The api-key input is required. Create a free key at https://protogrid.dev/account, store it as a repository secret (PROTOGRID_API_KEY) and pass api-key: ${{ secrets.PROTOGRID_API_KEY }}.",
    );
  }
  const baseUrl = (get("base-url") || "https://api.protogrid.dev").replace(/\/+$/, "");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new InputError(`base-url is not a URL: ${baseUrl}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  // The key travels in a header: never over plain http, except to a local test stack.
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) throw new InputError("base-url must use https.");
  const minRaw = get("min-score");
  let minScore = null;
  if (minRaw) {
    minScore = Number(minRaw);
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) throw new InputError(`min-score must be a whole number from 0 to 100, got "${minRaw}".`);
  }
  const directories = get("directories")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const d of directories) if (!DIRECTORY_IDS.includes(d)) throw new InputError(`directories accepts ${DIRECTORY_IDS.join(" and ")}, got "${d}".`);
  const timeoutRaw = get("timeout-seconds") || "120";
  const timeoutS = Number(timeoutRaw);
  if (!Number.isInteger(timeoutS) || timeoutS < 10 || timeoutS > 600) throw new InputError(`timeout-seconds must be a whole number from 10 to 600, got "${timeoutRaw}".`);
  return { url, apiKey, baseUrl, minScore, directories: [...new Set(directories)], timeoutS };
}

/**
 * The gate: fail when the server did not answer, when the score is under min-score (a server that
 * cannot be scored fails it too), and on blockers of the directories asked for. Warnings and
 * heuristic "review" items never fail the step.
 * @param {Check} check
 * @param {Pick<Inputs, "minScore" | "directories">} inputs
 */
export function evaluateGate(check, inputs) {
  /** @type {string[]} */
  const failures = [];
  const r = check.result;
  if (check.status !== "done" || !r) return { failures: ["The check could not be completed; try again later."], passed: false };
  const outcome = r.probe.outcome;
  // The probe error quotes the server's own answer: it goes to the fenced log and the summary, not here.
  if (!ANSWERED.includes(outcome)) failures.push(`The server did not answer the MCP probe (outcome ${outcome}).`);
  const score = r.quality.score;
  if (inputs.minScore !== null) {
    if (score === null) failures.push(`min-score is ${inputs.minScore} but the server could not be scored (too few applicable checks).`);
    else if (score < inputs.minScore) failures.push(`Quality score ${score} is under min-score ${inputs.minScore}.`);
  }
  for (const d of inputs.directories) {
    const dir = r.readiness.find((x) => x.directory === d);
    if (!dir) continue;
    const blockers = dir.items.filter((i) => i.status === "fail" && i.level === "must");
    if (blockers.length) failures.push(`${dir.name}: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} (${blockers.map((b) => b.title).join("; ")}).`);
  }
  return { failures, passed: failures.length === 0 };
}

/** Text for the job summary: no HTML, no Markdown structure, one line, capped. */
export function md(text, max = 300) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const capped = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
  return capped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|#!~])/g, "\\$1");
}

/** Data of a workflow command (annotation message), encoded as GitHub requires. */
export function commandData(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

const STATUS_MARK = { pass: "pass", warn: "warn", fail: "FAIL", na: "n/a", unknown: "unknown", manual: "manual" };

/**
 * The job summary in GitHub-flavored Markdown.
 * @param {Check} check
 * @param {Pick<Inputs, "minScore" | "directories">} inputs
 * @param {{ failures: string[]; passed: boolean }} gate
 */
export function renderSummary(check, inputs, gate) {
  const r = check.result;
  const lines = [`## protogrid check: ${md(check.url, 200)}`, ""];
  const why = gate.failures.length ? ["**Why it failed:**", "", ...gate.failures.map((f) => `- ${md(f, 600)}`), ""] : [];
  if (!r) {
    lines.push("**Gate failed.**", "", ...why, `[Open the check](${check.page})`);
    return lines.join("\n") + "\n";
  }
  const q = r.quality;
  lines.push(`- **Quality:** ${q.score === null ? md(q.label) : `${q.score} / 100 (${md(q.label)})`}`);
  lines.push(`- **Probe:** ${md(r.probe.outcome)}${r.probe.protocol.versions.length ? `, protocol ${md(r.probe.protocol.versions.join(", "))}` : ""}${r.probe.error ? `: ${md(r.probe.error, 200)}` : ""}`);
  lines.push(`- **Tools:** ${q.tool_count}${q.token_estimate !== null ? `, about ${q.token_estimate.toLocaleString("en-US")} tokens to load` : ""}`);
  if (check.server) lines.push(`- **Catalog listing:** ${md(check.server, 200)}`);
  lines.push(`- **Gate ${gate.passed ? "passed" : "failed"}:** ${["server answers", inputs.minScore !== null ? `min-score ${inputs.minScore}` : null, inputs.directories.length ? `no blockers for ${inputs.directories.join(", ")}` : null].filter(Boolean).join("; ")}`);
  lines.push("", ...why);
  const footer = [`[Full result on protogrid](${check.page}) (shareable, kept 30 days). Checked ${md(r.checked_at)}.`, "", "One credential-free, read-only probe: no tool was called and no audit is implied.", ""];
  if (!ANSWERED.includes(r.probe.outcome)) {
    // Without an MCP answer every check is n/a: listing them would read as a clean result.
    lines.push("No MCP answer, so nothing else could be checked. Make sure the URL is the MCP endpoint and reachable from the internet.", "", ...footer);
    return lines.join("\n");
  }

  const categories = Object.entries(q.components);
  if (categories.length) {
    lines.push("### Quality by category", "", "| category | score |", "|---|---|");
    for (const [c, v] of categories) lines.push(`| ${md(c)} | ${v === null ? "n/a" : v} |`);
    lines.push("");
  }
  const notPassing = q.checks.filter((c) => c.status === "fail" || c.status === "warn").sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1));
  lines.push("### Checks not passing", "");
  if (notPassing.length === 0) lines.push("None: every applicable check passes.");
  else for (const c of notPassing) lines.push(`- **${STATUS_MARK[c.status] ?? md(c.status)}** ${md(c.id, 80)}: ${md(c.detail)}`);
  lines.push("");

  lines.push("### Directory readiness", "", "| directory | blockers | warnings | to review |", "|---|---|---|---|");
  for (const d of r.readiness) lines.push(`| ${md(d.name)} | ${d.summary.blockers} | ${d.summary.warnings} | ${d.summary.review} |`);
  lines.push("");
  const manual = Math.max(0, ...r.readiness.map((d) => d.summary.manual));
  const unknown = r.readiness.reduce((n, d) => n + d.summary.unknown, 0);
  if (manual || unknown) lines.push(`${unknown ? `${unknown} item${unknown === 1 ? "" : "s"} could not be seen by the probe; ` : ""}${manual ? `${unknown ? "up" : "Up"} to ${manual} items per directory are manual (privacy policy, test account, screenshots...): see the full result.` : ""}`, "");
  for (const d of r.readiness) {
    const open = d.items.filter((i) => (i.status === "fail" || i.status === "warn") && i.kind !== "manual");
    if (!open.length) continue;
    lines.push(`**${md(d.name)}**`, "");
    for (const i of open) lines.push(`- ${i.status === "fail" && i.level === "must" ? "blocker" : i.kind === "heuristic" ? "review" : "warning"}: ${md(i.title, 200)} - ${md(i.detail)}`);
    lines.push("");
  }
  lines.push(...footer);
  return lines.join("\n");
}

class ApiError extends Error {}

/**
 * Talks to the protogrid API: queues a fresh check (the API key's account quota), then reads it until
 * it is finished or the timeout passes.
 * @param {Inputs} inputs
 * @param {typeof fetch} fetchImpl
 * @param {(msg: string) => void} log
 * @returns {Promise<Check>}
 */
export async function runCheck(inputs, fetchImpl, log, now = () => Date.now()) {
  const deadline = now() + inputs.timeoutS * 1000;
  const headers = { authorization: `Bearer ${inputs.apiKey}`, "user-agent": USER_AGENT, accept: "application/json" };
  const call = async (method, path, body) => {
    // Network errors and 5xx are retried twice; anything the API decided (4xx) is final.
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${inputs.baseUrl}${path}`, {
          method,
          headers: body ? { ...headers, "content-type": "application/json" } : headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout((MAX_WAIT_S + 20) * 1000),
          redirect: "error",
        });
      } catch (e) {
        if (attempt < 2) {
          log(`protogrid API unreachable (${e instanceof Error ? e.message : String(e)}), retrying`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new ApiError(`The protogrid API could not be reached: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status >= 500 && attempt < 2) {
        log(`protogrid API answered ${res.status}, retrying`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      const json = await res.json().catch(() => null);
      return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
    }
  };
  const waitS = () => Math.max(0, Math.min(MAX_WAIT_S, Math.floor((deadline - now()) / 1000)));

  const created = await call("POST", `/v1/check?wait=${waitS()}`, { url: inputs.url, fresh: true });
  if (created.status === 401) throw new ApiError("The API key was refused (unknown or revoked). Check the secret, or create a new key at https://protogrid.dev/account.");
  if (created.status === 400) throw new ApiError(`The URL was refused: ${created.json?.message ?? created.json?.reason ?? "invalid URL"}`);
  if (created.status === 429) {
    const msg = created.json?.message ?? "Too many requests.";
    throw new ApiError(`${msg}${created.retryAfter ? ` Try again in ${Math.ceil(Number(created.retryAfter) / 60)} minutes.` : ""}`);
  }
  if (created.status !== 200 && created.status !== 202) throw new ApiError(`The protogrid API answered ${created.status}.`);
  /** @type {Check} */
  let check = created.json;
  log(`check ${check.id} ${check.status}: ${check.page}`);
  while ((check.status === "queued" || check.status === "running") && now() < deadline) {
    const read = await call("GET", `/v1/check/${encodeURIComponent(check.id)}?wait=${waitS()}`);
    if (read.status !== 200) throw new ApiError(`Reading check ${check.id} answered ${read.status}.`);
    check = read.json;
  }
  if (check.status === "queued" || check.status === "running") {
    throw new ApiError(`The check did not finish within ${inputs.timeoutS} seconds; it keeps running at ${check.page}. Raise timeout-seconds if this repeats.`);
  }
  return check;
}

/** Appends name=value lines (single-line values only) to the GITHUB_OUTPUT file. */
function setOutputs(env, outputs) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v ?? "").replace(/[\r\n]+/g, " ")}`);
  appendFileSync(file, lines.join("\n") + "\n");
}

/**
 * The step: returns the exit code. Every line that may carry text from the checked server is printed
 * between stop-commands markers, so a crafted tool name cannot issue workflow commands.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @param {(s: string) => void} write
 */
export async function main(env = process.env, fetchImpl = fetch, write = (s) => void process.stdout.write(s)) {
  const log = (msg) => write(`${msg}\n`);
  const error = (msg) => write(`::error title=protogrid check::${commandData(msg)}\n`);
  let inputs;
  try {
    inputs = readInputs(env);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  write(`::add-mask::${inputs.apiKey}\n`);
  log(`protogrid check ${VERSION}: ${inputs.url}`);

  let check;
  try {
    check = await runCheck(inputs, fetchImpl, log);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const gate = evaluateGate(check, inputs);
  const r = check.result;
  const blockers = (d) => r?.readiness.find((x) => x.directory === d)?.summary.blockers ?? "";
  setOutputs(env, {
    "check-id": check.id,
    page: check.page,
    outcome: r?.probe.outcome ?? "",
    score: r?.quality.score ?? "",
    label: r?.quality.label ?? "",
    "claude-blockers": blockers("claude"),
    "openai-blockers": blockers("openai"),
    passed: gate.passed,
  });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(check, inputs, gate));

  const token = randomBytes(16).toString("hex");
  write(`::stop-commands::${token}\n`);
  if (r) {
    log(`quality ${r.quality.score === null ? r.quality.label : `${r.quality.score} (${r.quality.label})`}, probe ${r.probe.outcome}${r.probe.error ? `: ${r.probe.error.slice(0, 300)}` : ""}`);
    for (const c of r.quality.checks) if (c.status === "fail" || c.status === "warn") log(`  ${c.status.padEnd(4)} ${c.id}: ${c.detail}`);
    const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    for (const d of r.readiness) log(`${d.name}: ${count(d.summary.blockers, "blocker")}, ${count(d.summary.warnings, "warning")}, ${d.summary.review} to review`);
  }
  write(`::${token}::\n`);
  for (const f of gate.failures) error(f);
  log(gate.passed ? `gate passed: ${check.page}` : `gate failed: ${check.page}`);
  return gate.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
