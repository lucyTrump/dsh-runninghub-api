# dsh-runninghub-api

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：集成 [RunningHub](https://www.runninghub.cn) 云端 ComfyUI 工作流。设置卡片管理 API Key 与工作流库；7 个 `runninghub_*` 工具供 Agent 调用；sha256 媒体上传缓存；本地并发闸门 + FIFO 排队 + 超时；后台任务 + 完成通知；任务台账 + 重启自动恢复。

## 安装

```sh
dsh plugin --profile web add dsh-runninghub-api
```

或从应用内插件市场（dshmarket）安装/更新。然后打开 **设置 → 插件 → RunningHub** 添加 API Key 和工作流。

## 设置（`runninghub` 命名空间）

| 字段 | 默认值 | 用途 |
|---|---|---|
| `apiKey` | — | 字面量密钥（`role('secret')`），优先用 `apiKeyEnv` |
| `apiKeyEnv` | `RUNNINGHUB_API_KEY` | 每次请求解析的凭据引用 |
| `baseUrl` | `https://www.runninghub.cn` | OpenAPI 地址 |
| `pollIntervalMs` | `5000` | 状态轮询间隔（最小 1000） |
| `runTimeoutMs` | `3600000` | 运行阶段超时（0 = 不限） |
| `queueTimeoutMs` | `0` | 排队阶段超时（0 = 不限） |
| `maxConcurrentTasks` | `3` | 本地并发闸门 |
| `uploadUseLegacy` | `false` | 旧版 multipart 上传接口 |
| `workflows` | `[]` | 已保存的工作流定义 |

## 工具

`runninghub_list_workflows`、`runninghub_fetch_workflow`、`runninghub_run_workflow`（两阶段：缺少必填参数/媒体时返回 `needs_input` 而不提交）、`runninghub_get_task`、`runninghub_list_tasks`、`runninghub_cancel_task`、`runninghub_upload_file`（按 sha256 去重）、`runninghub_refresh_workflow`。

## Remote（`ctx.remote.runninghub`）

`fetchWorkflow`（拉取工作流 JSON + 解析）、`validateWorkflow`（免费干跑组装负载）、`runTest`（设置卡片用的真实付费提交）、`testConnection`。浏览器半在启动时通过 `ctx.remote.$mount()` 自挂载该命名空间。

## 开发

```sh
pnpm install        # 标准途径（npm registry）
pnpm build          # Typert 产物 + host lib + 客户端 bundle
pnpm test           # vitest
pnpm typecheck
```

离线开发（registry 不可达时，从本地 deepseek-harness checkout 链接依赖）：

```sh
node scripts/link-local-dsh.mjs [/path/to/deepseek-harness]
pnpm build
```

注意：用 `dsh plugin add <本目录>` 做 link 调试时，node_modules 里的 `@deepseek-ai/*` 必须是指向本地 DSH checkout 的软链（真实 npm 副本会造成 cordis 双实例）。所以每次 `pnpm install` 之后、重启 dsh 之前，重跑一次 `node scripts/link-local-dsh.mjs`。

装进本机 web profile 调试（link 安装，重新构建后重启生效）：

```sh
dsh plugin --profile web add /path/to/dsh-runninghub-api
```

`tests/` 覆盖：网关对 mocked fetch 的端点 A–F、状态码 0/804/805/813、密钥脱敏、无密钥快速失败；工作流 prompt 映射；负载校验/覆盖合并；媒体缓存。
