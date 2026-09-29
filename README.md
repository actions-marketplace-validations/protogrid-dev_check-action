# protogrid MCP server check

Check your remote MCP server in CI after every deploy: protocol conformance (2026-07-28), OAuth metadata, tool hygiene (descriptions, schemas, annotations, token cost) and readiness for the Claude and OpenAI (ChatGPT) directories.
The result goes to the job summary, with a shareable link, and the step fails when the gate you set is not met.

It runs [protogrid](https://protogrid.dev)'s on-demand check: one credential-free, read-only probe of your server.
No tool is ever called and no audit is implied.

**Your server must be reachable from the internet.**
The checker refuses private, loopback and internal addresses, so run this step after deploying to staging or production, not against a server started inside the runner.

## Usage

1. Sign in at [protogrid.dev](https://protogrid.dev/account) with GitHub and create a free API key.
2. Store it as a repository secret named `PROTOGRID_API_KEY`.
3. Add the step after your deploy:

```yaml
jobs:
  deploy:
    # ... your deploy to staging ...
  mcp-check:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: protogrid-dev/check-action@v1
        with:
          url: https://staging.example.com/mcp
          api-key: ${{ secrets.PROTOGRID_API_KEY }}
          min-score: 75          # optional
          directories: openai    # optional: fail on OpenAI directory blockers
```

Pin a commit SHA instead of `@v1` if your policy asks for it; the action is a single JavaScript file with no dependencies.

## Inputs

| input | required | default | meaning |
|---|---|---|---|
| `url` | yes | | Public URL of the remote MCP server. URLs with credentials or secret-looking query parameters are refused. |
| `api-key` | yes | | A protogrid API key, from a secret. |
| `min-score` | no | | Fail when the quality score (0 to 100) is under this. A server that cannot be scored fails it too. |
| `directories` | no | | `claude`, `openai` or both, comma-separated: fail on any blocker of those directories. |
| `timeout-seconds` | no | `120` | How long to wait for the result (10 to 600). |
| `base-url` | no | `https://api.protogrid.dev` | Leave the default. |

The gate always fails when the server does not answer the probe.
A server that answers with an OAuth challenge counts as answering: its authorization metadata is checked, and tool checks are not applicable without credentials.
Warnings and heuristic "review" items are reported and never fail the step.

## Outputs

| output | meaning |
|---|---|
| `check-id` | Id of the check. |
| `page` | Shareable result page, kept 30 days. |
| `outcome` | Probe outcome: `ok`, `auth_required`, `timeout`, `unreachable`, `protocol_error` or `blocked`. |
| `score` | Quality score 0 to 100, empty when the server could not be scored. |
| `label` | `good`, `needs work`, `poor` or `not scored`. |
| `claude-blockers`, `openai-blockers` | Blockers per directory. |
| `passed` | `true` when the gate passed. |

## Limits

Every run is a fresh check and counts against your API key's hourly allowance of on-demand checks (30 an hour on the free plan).
One server host can be checked 12 times an hour in total, so a busy pipeline should check once per deploy, not per commit on every branch.
See [Check your server](https://docs.protogrid.dev/guides/check-your-server/) and [API keys and limits](https://docs.protogrid.dev/reference/api-keys/).

## What is checked

The same checks as every server page on protogrid.dev: see [Quality score](https://docs.protogrid.dev/concepts/quality/).
Directory readiness lists every requirement of the Claude and OpenAI directories with its source; items nobody can see from outside (privacy policy, test account, screenshots) are listed as manual.

## Security

- The key is masked in the log and sent only to `base-url` over https.
- Text that comes from the checked server (tool names, details) is escaped in the summary and printed with workflow commands disabled.

## License

MIT
