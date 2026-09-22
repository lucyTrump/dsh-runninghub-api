# dsh-runninghub-api

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that integrates [RunningHub](https://www.runninghub.cn) cloud ComfyUI workflows: a configuration form for your API key and workflow library, eight `runninghub_*` tools for agents, a sha256 media upload cache, a local concurrency gate with FIFO queueing and timeouts, background tasks with completion notifications, and a durable task ledger with automatic restart recovery.

## Install

```sh
dsh plugin --profile web add dsh-runninghub-api
```

or install/update from the in-app plugin market (dshmarket). Then open the sidebar's **Plugins** page and open the **dsh-runninghub-api** card: the configuration form sits below the description (on DSH ≥ 0.1.6-alpha.2, plugin configuration moved out of **Settings → Plugins** onto the Plugins page).

## Settings (`runninghub` namespace)

| Field | Default | Purpose |
|---|---|---|
| `apiKey` | — | Literal key (`role('secret')`); prefer `apiKeyEnv` |
| `apiKeyEnv` | `RUNNINGHUB_API_KEY` | Credential reference resolved per request |
| `baseUrl` | `https://www.runninghub.cn` | OpenAPI base |
| `pollIntervalMs` | `5000` | Status poll interval (min 1000) |
| `runTimeoutMs` | `3600000` | Run-phase timeout (0 = unlimited) |
| `queueTimeoutMs` | `0` | Queue-phase timeout (0 = unlimited) |
| `maxConcurrentTasks` | `3` | Local concurrency gate |
| `uploadUseLegacy` | `false` | Legacy multipart upload endpoint |
| `workflows` | `[]` | Saved workflow definitions |

## Tools

`runninghub_list_workflows`, `runninghub_fetch_workflow`, `runninghub_run_workflow` (two-phase: reports missing required params/media as `needs_input` instead of submitting), `runninghub_get_task`, `runninghub_list_tasks`, `runninghub_cancel_task`, `runninghub_upload_file` (sha256-deduplicated), `runninghub_refresh_workflow`.

## Remote (`ctx.remote.runninghub`)

`fetchWorkflow` (workflow JSON fetch + parse), `validateWorkflow` (free dry-run payload assembly), `runTest` (real paid submit for the configuration form), `testConnection`. The browser half self-mounts this namespace via `ctx.remote.$mount()` at startup.

## Development

```sh
pnpm install        # canonical (npm registry)
pnpm build          # Typert artifacts + host lib + client bundle
pnpm test           # vitest
pnpm typecheck
```

Offline against a local deepseek-harness checkout (no registry access):

```sh
node scripts/link-local-dsh.mjs [/path/to/deepseek-harness]
pnpm build
```

Note: when link-installed into a live dsh profile (`dsh plugin add <this dir>`), the
`@deepseek-ai/*` entries in node_modules must be symlinks into the local DSH
checkout — real npm copies would duplicate the cordis singleton. Re-run
`node scripts/link-local-dsh.mjs` after every `pnpm install`, before restarting dsh.

Local install into the web profile (link install; rebuilds are picked up on restart):

```sh
dsh plugin --profile web add /path/to/dsh-runninghub-api
```

`tests/` covers the gateway against a mocked fetch (endpoints A–F, status codes 0/804/805/813, secret masking, no-key fast-fail), workflow prompt mapping, payload validation/override reconciliation, and the media cache.

## License

[MIT](LICENSE)
