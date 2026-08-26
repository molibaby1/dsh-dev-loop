# dsh-dev-loop

Bounded AI dual-layer development loop for a separate project repository.

## Runtime boundary

- Planner and Reviewer use DSH-Brain-Bridge ChatGPT Web transport with validated local attachments.
- Executor uses the installed `dsh-codex-subscription` DSH provider route: `openai-codex` / `gpt-5.6-luna`.
- The Executor is a DSH Agent, so DSH remains the tool, permission, session, and execution authority.
- The Controller never resets, cleans, commits, or pushes the product repository.

## Development

```bash
npm test
npm run package:fixture
```

`npm test` uses only fake Bridge/Executor/CDP seams. It does not consume ChatGPT or Codex quota.

## CLI

Packaging is local and read-only against the project:

```bash
node bin/dsh-dev-loop.mjs package --project /path/to/project --output /path/to/artifacts
```

A full run requires a DSH-host executor module; the CLI intentionally has no standalone
subscription API:

```bash
node bin/dsh-dev-loop.mjs run \
  --project /path/to/project \
  --output /path/to/artifacts \
  --problem-file problem.json \
  --executor-module ./dsh-host-executor.mjs \
  --bridge-url http://127.0.0.1:7688 \
  --bridge-token "$DSH_BRIDGE_TOKEN" \
  --approve
```

The host executor module must export `createExecutor()` or `execute()`. The DSH plugin host
adapter is the supported way to supply it.

## DSH host adapter

`src/plugin.mjs` can be loaded as a DSH plugin in the **Web profile**. It provides
`dshDevLoopExecutor` backed by `ctx.agents` and the installed `openai-codex` route. The selected
permission preset is `danger-full-access`, matching the approved unattended execution mode.

`cordis.patch.yml` is an explicit Web-profile overlay, not an automatic bundle patch. Apply it
only to the profile that provides `connection` and `web`; attaching the Controller to a minimal
headless profile will fail closed because `dsh-codex-subscription` is Web-bound.

The low-level `streamCodex()` helper pins the same provider/model when a host needs a direct
`ctx.llm.stream()` call. Normal repository execution should use the Agent adapter so DSH tools
and session evidence remain authoritative.

## Artifacts and security

Run artifacts are written to a Controller-owned root. ZIP packaging is deterministic and
reuses the Wuxia-Life exclusion policy without writing into Wuxia-Life. Each staged artifact
gets a byte count and SHA-256 hash; Bridge submission additionally enforces canonical-path,
symlink, root, size, and hash validation.

See [`docs/PRD/ai-dual-dev-loop.md`](docs/PRD/ai-dual-dev-loop.md) for the approved first-phase
contract and [`docs/PRD/ai-dual-dev-loop.prd.json`](docs/PRD/ai-dual-dev-loop.prd.json) for the
machine-readable scope.
