# DeepSeek Harness · RunningHub API 插件 — 实现方案

> 版本：v3（审查修订）
> 目标仓库：`/Users/lucytrump/github/deepseek-harness`（DSH checkout）
> 本文档所在目录：`/Users/lucytrump/test-temp/dsh-runninghub-api`
> API 依据：https://www.runninghub.cn/runninghub-api-doc-cn/llms.txt 及其子文档

---

## 0. 结论摘要（TL;DR）

本插件在 DSH 里落成**一个 Cordis 插件包（host 半 + client 半）**，放在 DSH 仓库内，通过四类机制满足全部需求：

| 需求 | 落地机制 |
|---|---|
| 1. 添加 API Key | 设置页「Plugins → RunningHub」卡片，`role('secret')` 加密存储、只写不读 |
| 2. 添加工作流 + 拉取 JSON + 节点默认参数编辑 + 测试 | 同一卡片内：填 workflowId → 拉取 → 解析 `prompt` → 可编辑节点参数/媒体槽位表 + 「校验(免费)/真实测试运行」 |
| 3. 对话面板看到提交参数 | `runninghub.run_workflow` 把**映射完成后的最终提交 payload** 写入返回结果 + 自定义聊天卡片渲染 |
| 4. 多工作流 + 图片/音频/视频自动识别 + 上传缓存 + 映射 | 工作流唯一 `label` + 默认工作流；媒体按**内容哈希**上传缓存；映射按**预声明媒体槽位顺序**确定性分配 + 数量校验 |
| 5. 并发上限 + 排队 + 超时 + 手动取消（新增） | 本地并发闸门（默认 3，设置页可改）；超限进本地 FIFO 队列 `PENDING`；单任务超时默认 60 分钟；排队与运行中任务均可手动取消 |

---

## 1. 需求理解与澄清

### 1.1 原始需求

1. 插件里添加 API Key。
2. 能添加工作流：输入 workflowId → 点击「拉取工作流」→ 自动调用接口获取最新工作流 JSON → 提供「工作流节点默认参数修改」设置。
3. 使用工作流时，在对话面板能看到「提交执行任务的接口提交参数」。
4. 支持多个工作流，设计多工作流在 DSH 对话里最方便的使用方式；图片根据上下文自动识别 → 先上传 RunningHub → 缓存 → 复用 → 映射不错。

### 1.2 已确认的补充决策（v2）

1. **代码位置**：插件放 **DSH 仓库内**（`packages/runninghub/dsh-runninghub`）。理由见 §3.1 对比。
2. **媒体范围**：支持**图片 / 音频 / 视频 / 图片 ZIP** 上传（对应 `LoadImage / LoadImages(zip) / LoadAudio / LoadVideo`）。
3. **结果文件**：成功后**立即下载到本地**，提供**默认路径 + 上下文指定 `saveTo`/`filenamePattern`**，并标记为产物文件。
4. **缺失参数**：设置页可标记「必填」；run 时缺必填/缺媒体槽位 → **不提交、不扣费**，返回 `needs_input` 缺项清单，模型经 `ask_user_question` 向用户收集后重跑。
5. **工作流 label**：每个工作流一个**唯一 `label`**，对话里直接用 label 点名；另有「默认工作流」。
6. **测试工作流**：提供「校验（免费）」+「真实测试运行（扣费，有提示）」两个按钮。
7. **失败可见**：`805` 失败时捕获 `failedReason`（节点名/异常/traceback）+ `promptTips.node_errors`，写入后台任务结果、`get_task` 返回、聊天卡片三处。
8. **后台运行不阻塞**：默认 `wait:false`，提交后立即返回后台任务（`ctx.jobs.start`），用 `job_list`/`job_output` 看进度，完成时 runtime 发通知——等待结果不阻塞后续对话。
9. **结果可恢复（超时/重启）**：DSH 后台任务句柄是进程内存态、不跨重启；插件落一个**任务台账（taskId→记录，JSON 持久化）**。超时或 DSH 重启后，用 `list_tasks`/`get_task(taskId)` 重新向 RunningHub 拉状态并补下载结果——RunningHub 是唯一真相源。
10. **单 API Key**（v1）；结构上留多 key 扩展位。
11. **默认保存路径** = 会话工作目录 `runninghub-outputs/`；仅当对话里明确指定 `saveTo` 时才切换。
12. **并发与超时**：本地并发闸门默认 **3 条**（设置页可改，热改即时生效）；超过 3 条进**本地队列排队**；**排队中与进行中任务均可手动取消**；执行超时默认 **60 分钟**（`runTimeoutMs`）、排队等待另设上限（`queueTimeoutMs`）。详见 §6.9。
13. **重启自动恢复**：DSH 重启后，插件启动时自动接管未终态任务——**进行中任务自动重查结果**、**排队任务自动重投**；`list_tasks`/`get_task` 仍作为手动兜底。详见 §6.8/§6.9。

### 1.3 我固化的隐含需求

- 「看到提交参数」= 看**图片/媒体上传、映射完成后的最终 `nodeInfoList`**，不是看模型传入的原始引用。
- 任务是异步的（`QUEUED → RUNNING → SUCCESS/FAILED`），必须封装状态机。
- 缓存要**内容寻址**（sha256），同文件多轮不重复上传。
- 映射防错靠「预声明槽位 + 顺序 + 数量校验」，不靠模型临场猜字段。

---

## 2. RunningHub API 能力梳理（已核实）

### 2.1 认证
- 请求头：`Host: www.runninghub.cn`、`Content-Type: application/json`（或 multipart）。
- 凭证：请求体带 `apiKey`；上传/拉取 JSON 接口额外带 `Authorization: Bearer <apiKey>`。
- host 侧统一注入，模型与 client 永远看不到明文 key。

### 2.2 端点清单

| # | 用途 | 方法 & 路径 | 关键请求体 | 关键响应 |
|---|---|---|---|---|
| A | 获取工作流 JSON | `POST /api/openapi/getJsonApiFormat` | `{apiKey, workflowId}` | `data.prompt`（JSON 字符串） |
| B | 发起任务（高级） | `POST /task/openapi/create` | `{apiKey, workflowId, nodeInfoList, addMetadata, webhookUrl, workflow, instanceType, usePersonalQueue, retainSeconds, accessPassword}` | `data.{taskId, taskStatus, clientId, promptTips, netWssUrl}` |
| C | 查询状态/结果 | `POST /task/openapi/outputs` | `{apiKey, taskId}` | `code`：0 成功（data=结果数组）、804 运行中、813 排队、805 失败（`failedReason`） |
| D | 取消任务 | `POST /task/openapi/cancel` | `{apiKey, taskId}` | `code/msg` |
| E | 文件上传（新） | `POST /openapi/v2/media/upload/binary` | multipart `file` | `data.{fileName, download_url, type, size}` |
| F | 文件上传（旧） | `POST /task/openapi/upload` | multipart `apiKey`+`fileType`+`file` | `data.{fileName, fileType}` |
| G | 查询 APIKEY 列表/队列 | （**待核实确切路径**）账户相关接口 | `{apiKey}` | key 列表/队列状态 |

> `fileName` 用于 ComfyUI 节点；`download_url` 用于标准模型 API 且**一天有效**。支持文件类型：图片 JPG/PNG/JPEG/WEBP、图片压缩包 ZIP、音频 MP3/WAV/FLAC、视频 MP4/AVI/MOV/MKV。

### 2.3 nodeInfoList 语义
- `[{nodeId, fieldName, fieldValue}]`，`nodeId` 是工作流 JSON 节点编号，`fieldName` 是 `inputs` 的 key。
- 媒体喂法：`LoadImage/LoadAudio/LoadVideo` 节点填上传 `fileName`；`LoadImageFromUrl` 填公网 URL。
- 注意：API 会**强制重置 seed**（要固定必须显式放进 nodeInfoList）；纯前端字段（`control_after_generate`、`group`）不存在于 api_format，不参与；值为 `[]` 包裹的通常是连线，不建议改。

---

## 3. 总体架构

### 3.1 代码位置：仓库内（已确认）

拆成**两个 Cordis 包**（实现期确定：普通包只能进一个 aggregate，不能既进 host 又进 client）：

- host 半：`packages/runninghub/dsh-runninghub/`（`@deepseek-ai/dsh-runninghub`，`src/`）
- client 半：`packages/runninghub/dsh-runninghub-client/`（`@deepseek-ai/dsh-client-runninghub`，`src/client/`）

先例：`dsh-host-open-in-app` + `dsh-client-ui-open-in-app` 双包拆分。

**仓库内 vs 项目目录外挂对比：**

| | 仓库内（推荐） | 项目目录外挂 |
|---|---|---|
| 在当前 127.0.0.1:3080 GUI 生效 | ✅ 挂载后重建即可 | ⚠️ 需复刻 bundle 格式 + 让 Loader 解析到外挂包 |
| 构建 / HMR | ✅ 仓库 tsdown preset；client 半 HMR；host 半 cordis 热重载 | ❌ 全手工 |
| 修 bug / 调试 | ✅ typecheck/lint/vitest、源码断点、`dev:web` 增量热更 | ❌ 无仓库工具链 |
| 保持 checkout 干净 | ❌ 会改 DSH 本身 | ✅ |

**开发/调试工作流（仓库内）：**
- client 半（设置卡片、聊天卡片）：起 `pnpm run dev:web` 后 HMR 增量热更，改完即时生效。
- host 半（gateway/tools/store/轮询）：Cordis 插件注册是 `ctx.effect`，走 vendored HMR 热重载；必要时重启 `dsh` web。
- 断言用 `vitest`（gateway 打 mock、映射/缓存单测），日志走 `ctx.logger`。

### 3.2 两半职责

| | Host 半（`dsh-runninghub/src/`） | Client 半（`dsh-runninghub-client/src/client/`） |
|---|---|---|
| 注册 | `ctx.settings.installSection` + `ctx.tools.register` | `settings.plugin.item` 卡片 + `tool.call.toolview` 卡片 |
| 能力 | 网络、文件读写、缓存、轮询 | 表单、JSON 编辑、结果预览 |
| 凭证 | 持有并注入 `apiKey` | 只写不读（`role('secret')`） |

### 3.3 挂载点
`packages/bundle/web-app/cordis.patch.yml` 的 `insert:` 加 host + client 两行（client 声明 `dsh.client`，被 `modules` 扫进 `window.__DSH_BOOT__`）。配套 `tsconfig.*.json` references、`pnpm install`、`constraints/typecheck/lint/build`，改的是 apps/web shell + 普通包，需重建 Web 产物并刷新页面。

### 3.4 数据流
```
[设置页] 配 API Key / 添加工作流(workflowId+label) → 拉取 → 解析 prompt → 存默认参数+媒体槽位
[对话]   "用 <label>，把这两张图合视频，存到 ./out"
        模型(skill 指引) → runninghub.run_workflow(label, params, media[按槽位顺序], saveTo, filenamePattern)
           ├─ 校验必填/槽位数量 → 缺则返回 needs_input(不提交不扣费) → ask_user_question → 重跑
           ├─ 解析媒体引用 → sha256 查缓存 → 命中? 复用 fileName : 上传(E/F) 写缓存
           ├─ 按媒体槽位顺序填 fileName/URL 进 nodeInfoList
           ├─ 合并 nodeDefaults + 本次覆盖 → 生成最终 payload
           ├─ POST create(B) → taskId → 轮询 outputs(C)
           └─ 成功 → 下载结果到本地(默认路径或 saveTo) → present → 返回 {最终payload, 结果, 本地路径}
```

---

## 4. 数据模型

### 4.1 设置（Settings namespace: `runninghub`）

```ts
interface RunningHubConfig {
  apiKey?: string            // role('secret')；v1 单 key（多 key 为 deferred，见 §8.12，不在本版预建数组）
  baseUrl?: string           // 默认 https://www.runninghub.cn（改动时 Host header 同步跟随）
  defaultWorkflowLabel?: string
  pollIntervalMs?: number    // 默认 5000
  runTimeoutMs?: number      // 默认 3600000（60 分钟）：仅计执行期（RUNNING 起算），设置页可改
  queueTimeoutMs?: number    // 默认 0（不限）：平台侧 QUEUED 排队等待上限，设置页可改
  maxConcurrentTasks?: number// 默认 3（本地并发闸门，设置页可改，热改即时生效）
  uploadUseLegacy?: boolean  // 默认走新接口，失败回退旧接口
}

interface WorkflowDefinition {
  label: string              // 唯一、对话引用名（用户输入）
  description?: string       // 可选备注
  workflowId: string         // 平台 ID
  prompt?: object            // 拉取到的最新 JSON
  fetchedAt?: string
  nodeDefaults: NodeParamOverride[]   // 节点默认参数
  mediaSlots: MediaSlot[]             // 媒体槽位声明
}

interface NodeParamOverride {
  nodeId: string
  fieldName: string
  fieldValue?: unknown       // 与工作流 JSON 同型；必填参数此项为空（无默认值）
  label?: string             // 友好名（如「正向提示词」「步数」）
  kind: 'text'|'number'|'boolean'|'url'|'select'|'json'   // 媒体类字段统一走 mediaSlots，不在此表
  required?: boolean         // 必填=无可用默认值、运行时必须由用户/模型显式提供（不用 fieldValue 兜底）
}

interface MediaSlot {
  nodeId: string             // LoadImage / LoadImages(zip) / LoadAudio / LoadVideo / LoadImageFromUrl
  fieldName: string          // 通常 image / audio / video / upload
  label: string              // 如「首帧」「尾帧」「参考图1」
  order: number              // 决定媒体分配顺序（防错关键）
  type: 'image'|'audio'|'video'|'zip'
  viaUrl?: boolean           // true=填 URL（LoadImageFromUrl），false=上传 fileName
  required?: boolean         // 必填槽位：缺则报错；可选槽位缺则跳过/置空
}
```

### 4.2 媒体上传缓存（运行时状态，非设置）

```ts
// 落盘：<dsh 数据目录>/runninghub/media-cache.json 或 storage-json
interface MediaCacheEntry {
  sha256: string             // 文件字节哈希（key）
  fileName?: string          // 上传后 fileName（复用）
  downloadUrl?: string       // 一天有效，仅备查 / 供 LoadImageFromUrl 填 URL
  sourceRef?: string         // 回源引用（本地路径/http(s)/data:），fileName 失效时用于重传
  type?: string
  size?: string
  uploadedAt?: string
}
```

### 4.3 任务台账（持久化，跨重启恢复）

```ts
// 落盘：<稳定数据目录>/runninghub/tasks.json（跨 DSH 重启保留）
interface TaskRecord {
  taskId?: string             // PENDING（本地排队未提交）时无 taskId
  jobId?: string              // 关联的 DSH 后台 job（运行时）
  workflowLabel: string
  workflowId: string
  status: 'PENDING'|'QUEUED'|'RUNNING'|'SUCCESS'|'FAILED'|'CANCELLED'|'TIMEOUT'
  queuePosition?: number      // PENDING 时在本地队列中的位次
  submittedAt: string         // PENDING=入队时间；已提交=提交时间
  finishedAt?: string
  savedTo?: string            // 结果保存目录（成功补下载时用）
  payload?: { nodeInfoList: [{nodeId,fieldName,fieldValue}], addMetadata?, instanceType?, ... } // PENDING 重投所需（apiKey 已脱敏）
  results?: [{ fileUrl, fileType, nodeId, localPath? }]
  failure?: { nodeName?, exceptionMessage?, traceback?, nodeErrors? }
}
```

> 目的：RunningHub 是唯一真相源（任务在其服务器跑），台账保存「如何重新找回」的最小事实，不保存媒体原文件。
> - 已提交任务（有 taskId）：只存 `taskId` + 元数据，恢复靠 `get_task` 重查补取。
> - 本地 `PENDING` 任务（未提交、无 taskId）：在 `payload` 字段持久化其**完整提交参数**（nodeInfoList + media fileName），重启后可经 `list_tasks` 看到并安全重投（未扣费，不存媒体字节）；重投前校验 fileName 有效性，失效回源重传。

---

## 5. 需求 → 机制映射（总表）

| 需求 | Host 半 | Client 半 | 模型看到/用到 |
|---|---|---|---|
| 1 API Key | 注入、脱敏、测试连接 | 表单写入（secret） | 无 |
| 2 工作流管理+测试+更新 | fetch/解析/持久化 + dry-run 校验 + 重新拉取更新 | 添加/删除/拉取/参数表/槽位排序/校验/测试运行/重新拉取 | `list_workflows`/`fetch_workflow`/`refresh_workflow` |
| 3 提交参数可见 | 结果回传最终 payload | 聊天卡片 JSON + 结果预览 | 工具返回文案 |
| 4 多工作流+媒体 | 上传缓存、映射、校验、默认 label | 槽位顺序可视化 | skill + `run_workflow` |
| 5 并发/排队/超时/取消 | 本地并发闸门 + FIFO 队列 + 超时 + cancel(D) | `maxConcurrentTasks` 表单 + 队列/状态展示 | `run_workflow`/`list_tasks`/`cancel_task` |

---

## 6. 核心设计

### 6.1 API Key 管理
- `apiKey` 标 `role('secret')`：host 可读、任何 response/client 读不到明文。
- 「测试连接」按钮：优先用**无需 workflowId 的轻量接口**（如 G，路径实现前回 RunningHub 文档核实）；或调 A 传任意 workflowId，据返回区分「key 无效」vs「workflowId 无效」。回显 `code/msg`，不回显 key。
- 所有出站请求经 gateway 统一注入 auth；日志/错误/提交 payload 一律脱敏（`Bearer xxx`、`apiKey` 替换为 `***`）。

### 6.2 工作流管理 + 测试（需求 2 + 确认点 5/6）

交互流（设置卡片内）：

1. 「添加工作流」→ 填 `label`（唯一）+ 可选 `description` + `workflowId`（支持粘贴平台 URL，自动截取末尾数字）。
2. 点击「拉取工作流」→ host 调 A → `JSON.parse(data.prompt)` → 遍历节点生成两张表（**互不重复**）：
   - **节点默认参数表**：每个 `nodeId.inputs[fieldName]` 一行；排除「值为 `[]` 的连线」「纯前端字段」「Load* 媒体的 image/audio/video/upload 字段（统一进媒体槽位表）」；`fieldValue` 可编辑，类型按原值推断；可勾「必填」（见下）；可填友好 `label`。
   - **媒体槽位表**：识别 `class_type` 为 `LoadImage / LoadImages(zip) / LoadAudio / LoadVideo / LoadImageFromUrl` 的节点 → 声明 `type` + `label` + `order`（+ `viaUrl`）+ `required`（必填/可选）。
   > **「必填」语义（已修订）**：必填 = **无可用默认值、运行时必须显式提供**；有默认值（`fieldValue` 非空）的参数不应勾必填。校验只看「本次是否显式提供」，不用默认值兜底。
3. 保存 → 持久化 `WorkflowDefinition[]`。
4. **校验（免费）**：调 A 验证 apiKey+workflowId 有效；本地比对 `nodeDefaults[].{nodeId,fieldName}` 是否都存在于最新 JSON，报告不存在的字段；不创建任务、不扣费。
5. **真实测试运行**：按当前默认参数真实提交一单（明确「将产生费用」提示）；媒体槽位按 `required` 决定是否可跳过；展示最终提交 payload + 轮询结果预览。**测试运行同样计入本地并发闸门**（§6.9），避免绕过限流。
6. **重新拉取（更新工作流）**：每个已存工作流提供「重新拉取」按钮 → host 调 A 重新取最新 `prompt` → 与已存版本做 **diff**（新增/删除/变更的节点参数与媒体槽位）→ 用户确认后**合并**持久化：按 `(nodeId, fieldName)` 尽力保留用户手改的 `label`/`required`/`order`，新增项补入、消失项标记并提示。不创建任务、不扣费。

> 「默认参数」语义：run 时 `最终 nodeInfoList = nodeDefaults + 本次 params 覆盖 + 媒体槽位自动填充`，后者覆盖前者，按 `(nodeId, fieldName)` 去重。

### 6.3 对话面板展示提交参数（需求 3）
- `run_workflow` 规范返回含：
  ```ts
  {
    kind?: 'background',               // 后台分支（§6.8）
    jobId?: string,
    taskId?: string,                  // PENDING 本地排队阶段为空；提交后才有
    workflowLabel, workflowId, status,
    submittedPayload: { workflowId, nodeInfoList, addMetadata, instanceType, ... },  // apiKey 脱敏
    resolvedMedia: [{ order, label, sha256, fileName }],
    savedFiles?: [{ localPath, fileType, nodeId, fileUrl }],
    results?: [{ fileUrl, fileType, nodeId }],
    failure?: { nodeName?, exceptionMessage?, traceback?, nodeErrors? }   // 805 失败详情
  }
  ```
- `output.render` 输出模型摘要（含完整 payload JSON，便于在日志里查看）。
- client 注册 `tool.call.toolview`（key=`runninghub.run_workflow`）：卡片分「提交参数」（JSON 高亮 + 复制）与「结果」（图片预览、视频/音频播放/下载、本地保存路径）。失败态渲染 `promptTips.node_errors` / `failedReason`。

### 6.4 多工作流在对话中的使用方式（需求 4 前半 + 确认点 5）
- 唯一 `label` + `defaultWorkflowLabel`（只有一个工作流时它就是默认）。
- 模型经 `runninghub.list_workflows` 感知全部 `label/name/workflowId/槽位摘要`。
- **label 匹配**：① 精确（label == 用户点名）→ ② 包含（label **包含**用户输入的关键词，唯一命中则选它、多个命中则列出让用户确认）→ ③ 默认工作流兜底。
- 内置 `runninghub` skill（`modelInvocable: true`）约束标准用法：
  1. 用户提到「跑/生成/合成」→ 先 `list_workflows`。
  2. 用户点名 label 或「默认」→ 选中对应工作流。
  3. 收集上下文媒体（附件/工作区文件/URL）→ 按**媒体槽位 order** 排序 → 传 `run_workflow`。
  4. 缺参数/媒体 → `run_workflow` 返回 `needs_input` → 用 `ask_user_question` 收集 → 重跑。
- 「最方便」= 用户自然语言点名 label + 甩文件，其余由 skill+工具兜底。

### 6.5 媒体自动识别 + 上传 + 缓存 + 映射（需求 4 后半 + 确认点 2）

**识别**：模型在 skill 指引下识别「本轮上下文媒体」——工作区文件路径（DSH 附件/文件工具已知路径）、`http(s)://` URL、`data:` URL。host 不强依赖解析会话内部结构。

**上传 + 缓存（内容寻址，任意文件类型）**：
1. 对每个媒体引用读字节（本地读文件 / 下载 URL / 解 data:）。
2. `sha256(bytes)` 查 `media-cache.json`：命中且 fileName 有效则复用 `fileName`；未命中/已失效调 E（失败回退 F）→ 写 `{sha256, fileName, downloadUrl, sourceRef, type, size, uploadedAt}`。
3. 缓存不存原文件字节，但存 **`sourceRef` 回源引用**（本地路径/http(s)/data:）——fileName 失效时回源重传；回源也不可达时显式报错（不静默用失效 fileName）。
4. **fileName 长期有效性待官方确认**（§10）；官方确认前，回源引用是重传兜底。

**映射（三层防错）**：
1. 预声明：槽位在设置页登记 `(nodeId, fieldName, label, order, type, required, viaUrl)`。
2. 确定性顺序：`media[i]` 按 `order` 升序填入 `mediaSlots[i]`；模型也可显式 `{ slot: "尾帧", ref }`。
3. 校验：**必填槽位**缺失且无显式槽位 → 报「缺第 N 个槽位(label)」；**可选槽位**缺则跳过/置空；绝不静默错配；媒体扩展名与 `type` 不符时报错。
4. **槽位取值（区分 viaUrl）**：
   - `viaUrl:false`（LoadImage / LoadImages(zip) / LoadAudio / LoadVideo）：上传后填 `fileName`。
   - `viaUrl:true`（LoadImageFromUrl）：需要**公网 URL**——ref 是本地路径/`data:` 时**先上传拿返回的 `download_url` 填入**；ref 本身是 `http(s)://` 则直接用。类型不混用。

### 6.6 结果文件保存（确认点 3）
- 成功即下载，不依赖有时效的 URL。
- 默认目录：`<cwd>/runninghub-outputs/<label>/<taskId>/`（`cwd` = `exec.agent.session.header.cwd`；取不到则回退到插件数据目录）。
- 上下文指定：
  - `saveTo?: string` —— 绝对路径或相对 cwd 的目录。
  - `filenamePattern?: string` —— 默认 `{index}_{nodeId}.{ext}`；占位符 `{taskId}/{nodeId}/{index}/{ext}/{fileType}`。
- 下载后：返回本地路径 + 原 `fileUrl/fileType`；标记为产物文件。**后台分支**（wait:false）任务成功后由插件**自动 present** 下载文件并写台账 `savedTo`，不依赖模型再次 present。

### 6.7 缺失参数向用户收集（确认点 4）
- 设置页给节点参数勾「必填」（**必填 = 无默认值、必须显式提供**，见 §6.2）。
- `run_workflow` 在提交前校验：**必填参数在「本次 params」里被显式提供**（不用默认值兜底）+ **必填媒体槽位**齐备。
  - 缺失 → **不提交、不扣费**，返回 `status: "needs_input"` + `missing: [{nodeId, fieldName, label, why}]`。
- skill 指令：收到 `needs_input` → `ask_user_question` 收集 → 带齐参数重跑 `run_workflow`。

### 6.8 后台运行 + 失败可见（不阻塞对话）

复用 DSH 原生**后台任务机制**（`ctx.jobs.start`，通过声明合并给 `JobKindMap` 增加 `runninghub` kind），不自己造轮子：

- **默认后台（`wait:false`）**：`run_workflow` 提交任务成功后**立即返回** `{ kind:'background', jobId }`，不占住当前对话回合。
  - `label = "RunningHub <label> <taskId>"`；`owner = exec.agent`（保留会话隔离 + 完成通知）。**已核实 DSH 源码**：`owner` 可选，但省略 owner 会失去会话隔离与完成通知（`tool-jobs` 对 unowned job 不投递通知）；且 owner/服务销毁时 DSH 会以 `cancel('owner disposed')` / `cancel('jobs service disposed')` 回调我们的 `hooks.cancel(reason)`——**据此分支**：
    - teardown 分支（`owner disposed` / `jobs service disposed`）→ **不调 RunningHub cancel**，仅停本地轮询、落台账（任务在平台继续跑）、`done` 以 `killed` settle 关闭本地句柄；后续靠台账 + 启动自动恢复/`get_task` 兜底。
    - 用户取消（`job_kill` / `cancel_task`）→ 真正调 RunningHub cancel(D) + 释放槽位。
  - `run()` 启动轮询器：`readOutput()` 流式回吐状态行（排队/运行/成功/失败）；`done` 在终态 settle；`cancel()` 调 RunningHub cancel(D)。
- **运行时可见性**：
  - 聊天卡片即时显示「后台任务已启动 jobId=runninghub-N（taskId=…）」。
  - `job_list` 列出运行中的任务；`job_output <id>` 读最新状态；`runninghub.get_task(taskId)` 查平台侧状态。
- **完成后非阻塞通知**：任务 settle 时 runtime 给 owner agent 发一条完成通知（成功带结果、失败带原因）。用户看到通知后，模型再按需继续——等待结果**不阻塞**后续对话工作。
- **失败可见（关键）**：`805` 失败时捕获 `failedReason.{node_name, exception_message, traceback}` 与 `promptTips.node_errors`，写入三处：
  1. 后台任务 `JobOutcome`（`failed` + `detail` + `output`）→ `job_output` 可看；
  2. `runninghub.get_task` 返回；
  3. 聊天卡片「结果」区渲染失败原因（节点名 + 异常 + traceback 折叠）。
- **终态映射**：成功→`completed`；平台失败→`failed`（detail=失败摘要）；用户取消→`killed`。
- **前台模式（`wait:true`）**：当模型需要「拿到结果再继续下一步」时同步轮询到终态；执行超时返回 `TIMEOUT` 并提示「可能仍在运行、可 `get_task` 补取」，用于串行链路。

**结果可恢复（超时/重启，关键）**：
- DSH 后台任务句柄是**进程内存态**（`jobs-local` 每记录在内存），**重启即丢**；不能靠它跨重启取结果。
- RunningHub 任务在**其自身服务器**上跑，与 DSH 无关；`taskId` 是唯一取回凭证。
- 插件维护**任务台账**（JSON 持久化到稳定数据目录，跨重启保留）：`taskId → { workflowLabel, workflowId, status, submittedAt, finishedAt, savedTo }`。
- **启动自动恢复（已确认）**：插件 `apply` 阶段读台账，自动接管未终态任务——
  - 已提交但未终态（`QUEUED`/`RUNNING`）：为每条起后台重查器，重新轮询 `outputs`；`SUCCESS` → 自动补下载结果到记录路径并置 `SUCCESS`；`FAILED` → 补取 `failedReason` 并置 `FAILED`；仍 `QUEUED`/`RUNNING` → 继续轮询（执行超时受新一轮 `runTimeoutMs` 约束）。
  - 本地 `PENDING`（排队未提交）：自动重投（提交参数已持久化、未扣费，重投安全），恢复排队/提交。
  - **恢复顺序与并发**：重查的 QUEUED/RUNNING 同样占用本地并发槽位；启动时**先恢复重查**（已在 RunningHub 侧跑），再按 FIFO 对 PENDING 重投；重投前校验 media fileName 有效性，失效回源重传。
- **手动兜底路径（仍可用）**：`runninghub.list_tasks` 读台账列出历史任务 → `runninghub.get_task(taskId)` 重新查 RunningHub → 成功补下载结果、失败补取失败原因。
- `get_task` 幂等：每次查询后，若已成功且本地尚无结果文件，自动补下载到默认/记录路径。
- **超时（拆分）**：`queueTimeoutMs`（平台侧 `QUEUED` 排队等待上限，默认不限）与 `runTimeoutMs`（进入 `RUNNING` 后执行上限，默认 60 分钟）。执行超时 → job 以 `TIMEOUT` settle，台账保留 `taskId` 并提示「可能仍在运行」，交由下次启动自动恢复或 `get_task` 补取；排队超时按 `queueTimeoutMs` 策略处理（取消或提示）。
- **边界（诚实说明）**：RunningHub 输出 `download_url` 可能一天有效——重启自动查询能确认「已成功」，但若结果链接已过期则可能下载不到文件，只能提示「成功但链接过期，需重跑」；故 §6.6「成功即下载」是核心兜底。重启后原 agent/会话可能已不在，完成通知未必能回到原对话，但结果文件 + 台账 + `list_tasks`/`get_task` 不丢。

**webhook 何时才需要（可选，v1 默认不做）**：
- 轮询已覆盖交互场景；webhook 仅当「DSH 部署有公网 URL 且需即时/外部系统联动」才有意义（本地 127.0.0.1 收不到回调）。
- 结构上 `webhookUrl` 作为 `run_workflow` 可选透传参数保留，无需额外机制。

### 6.9 并发控制、本地排队与超时（新增需求 5）

在**插件本地**加一个并发闸门，限制同时「已提交 RunningHub」的任务数，超过即本地排队：

- **并发上限**：`maxConcurrentTasks`，默认 **3**，设置页「Plugins → RunningHub」可改。
- **超过上限排队**：新任务进入**本地 FIFO 队列**（状态 `PENDING`：未提交、未扣费、无 taskId），等有任务进入终态后**自动补位提交**。
- **超时拆分**：`runTimeoutMs` 默认 **60 分钟**（3600000，仅计执行期、`RUNNING` 起算）+ `queueTimeoutMs`（平台侧排队等待上限，默认 0=不限）。执行超限 → 任务按 `TIMEOUT` settle，台账保留 taskId 并提示「可能仍在运行」，可经 `get_task` 补取（见 §6.8）。
- **排队与运行中均可手动取消**：
  - `PENDING`（本地排队）：从队列移除 → `CANCELLED`，**不调** RunningHub。
  - `QUEUED`/`RUNNING`（已提交）：调 RunningHub `cancel`(D) → `CANCELLED`，并**释放并发槽位**。
- **热改生效**：`maxConcurrentTasks`/超时在设置页修改后**即时生效**，仅影响之后获取槽位/起算超时的任务；对已在跑任务不追溯调整。
- **测试运行计入闸门**：设置页「真实测试运行」同样占并发槽位、受闸门限制（§6.2）。
- **实现映射到 DSH 后台 job**：每次 `run_workflow(wait:false)` 仍是一个 `kind:'runninghub'` job；其 `run()` 内部先 `acquire()` 槽位（满则 `await`，可被 cancel 中断），拿到槽位才 create(B) 并轮询；终态 `release()` 槽位并唤醒队首。`job_output` 可看到「本地排队第 N 位 / 前面 M 个」与「已提交 / 运行中」状态行。
- **两套「排队」语义区分**（避免混淆）：`PENDING`=**本地**队列（未提交）；`QUEUED`=**RunningHub 平台侧**队列（已提交）。终端展示与文案统一标注来源。
- **重启语义（自动恢复）**：本地 `PENDING` 队列本身是进程内存态（DSH 重启即丢），但每条 PENDING 的提交参数已持久化到台账（§4.3）——启动时**自动重投**恢复排队；已提交的 QUEUED/RUNNING 由启动自动恢复**自动重查结果**（§6.8）。两条自动恢复统一在插件 `apply` 阶段完成：先重查 RUNNING（占槽位），再按 FIFO 重投 PENDING。

---

## 7. 工具（Tools）设计

### 7.1 `runninghub.list_workflows`
- 参数：无（或 `detail?: boolean`）。
- 返回：`{ workflows: [{ label, description, workflowId, mediaSlots: [{label, order, type, viaUrl, required}], params: [{label, nodeId, fieldName, kind, required, defaultValue}], nodeDefaultsCount }] }`。
  - `params` 是关键：把「友好名 → (nodeId, fieldName)」映射交给模型，模型据此把用户自然语言（「正向提示词=…」「步数=…」）翻译成 `run_workflow` 的 `params` 结构。

### 7.2 `runninghub.fetch_workflow`
- 参数：`workflowId`（或 label）。
- 返回：`{ workflowId, label?, nodes: [{nodeId, classType, title}], mediaSlot 候选, params: [{label, nodeId, fieldName, kind, required}] }`。

### 7.3 `runninghub.run_workflow`（核心）
- 参数：
  ```ts
  {
    workflow: string,                 // label 或 workflowId
    workflowJson?: object,            // 高级：直接传完整工作流 JSON 覆盖 workflowId（§8.7）
    params?: Record<string, Record<string, unknown>>, // nodeId→fieldName→value
    media?: Array<{ ref: string, slot?: string }>,     // ref=路径/URL/data:；slot=可选槽位 label
    wait?: boolean,                   // 默认 false：提交后立即返回后台任务；true=同步轮询到终态
    saveTo?: string,                  // 结果保存目录
    filenamePattern?: string,         // 结果命名规则
    runTimeoutMs?: number,            // 覆盖执行超时（默认 60 分钟）
    queueTimeoutMs?: number,          // 覆盖排队等待上限（默认不限）
    // 高级透传：instanceType? usePersonalQueue? retainSeconds? addMetadata? accessPassword?
  }
  ```
- 流程：校验(6.7) → 媒体缓存/上传(6.5) → 填槽位 → 合并 nodeDefaults → 生成 payload → 本地并发闸门(6.9) → create(B) → 分叉：
  - `wait:false` → `jobs.start(kind:'runninghub', ...)`：job 内先占槽位（满则本地 `PENDING` 排队、可取消），拿到槽位才 create(B) 并轮询；**立即返回 `{ kind:'background', jobId }`（此刻可能尚无 taskId，taskId 经 `job_output` 后续提供）**（§6.8/§6.9）。
  - `wait:true` → 同步占槽位 → create(B) → 轮询 outputs(C) → 下载结果(6.6)。
- 返回（终态 / 查询态）：
  ```ts
  {
    kind?: 'background',              // 仅后台分支：配合 jobId
    jobId?: string,
    taskId?: string,                  // PENDING 本地排队阶段为空；提交后才有
    workflowLabel, workflowId, status,
    submittedPayload: { workflowId, nodeInfoList, addMetadata, instanceType, ... }, // apiKey 脱敏
    resolvedMedia: [{ order, label, sha256, fileName }],
    savedFiles?: [{ localPath, fileType, nodeId, fileUrl }],
    results?: [{ fileUrl, fileType, nodeId }],
    failure?: {                       // 805 失败时
      nodeName?: string,
      exceptionMessage?: string,
      traceback?: string,
      nodeErrors?: Record<string, unknown>,   // promptTips.node_errors
    },
    missing?: [{ nodeId, fieldName, label, why }],  // needs_input 时
  }
  ```

### 7.4 `runninghub.get_task`
- 参数：`taskId`（或本地 `PENDING` 任务对应的 `jobId`）。
- 返回：归一化状态 + 结果文件数组（0/804/813/805 → 可读状态）；对 `PENDING` 返回当前队列位次。
- 幂等 + 自愈：查 RunningHub 后，若已成功且本地尚无结果文件，自动补下载到台账记录的 `savedTo`（默认路径）并回传本地路径。

### 7.5 `runninghub.list_tasks`
- 参数：`limit?`（默认 20）。
- 返回：读持久化台账，列出任务 `[{taskId?, jobId?, workflowLabel, status, queuePosition?, submittedAt, finishedAt}]`；`status` 含 `PENDING/QUEUED/RUNNING/SUCCESS/FAILED/CANCELLED/TIMEOUT`。
- 用途：DSH 重启/超时后找回任务，再交给 `get_task` 补结果；同时可查看本地排队/运行中的任务。

### 7.6 `runninghub.cancel_task`
- 参数：`taskId`（或本地 `PENDING` 任务对应的 `jobId`）。
- `QUEUED`/`RUNNING`（已提交）：调 D，返回 `code/msg`，释放并发槽位，台账置 `CANCELLED`。
- `PENDING`（本地排队，无 taskId）：从本地队列移除 → `CANCELLED`，不调 RunningHub。
- 等价入口：直接 `job_kill` 对应后台 job，其 `cancel()` 已覆盖上述两种情况。

### 7.7 可选 `runninghub.upload_file`
- 参数：`ref` + 可选 `purpose`。
- 返回：`{ sha256, fileName, downloadUrl, type, size }`。
- 用途：显式「先传、拿 fileName、再手动填字段」的高级用法；一般由 `run_workflow` 内部完成。

### 7.8 `runninghub.refresh_workflow`
- 参数：`workflow`（label 或 workflowId）+ 可选 `apply?: boolean`（默认 false=仅返回 diff；true=持久化更新）。
- 返回：`{ workflowId, label, diff: { params: {added, removed, changed}, mediaSlots: {added, removed, changed} }, applied }`。
- 用途：重新拉取 RunningHub 最新工作流定义并更新本地存储（合并用户编辑，见 §6.2 第 6 步）；与设置页「重新拉取」按钮同一能力，模型/对话也可触发。

> 工具名统一 `runninghub.` 前缀（注册名 `name` = `runninghub.<x>`，模型见到的即此名；聊天卡片用同名 `tool.call.toolview` key 渲染，无独立显示名）；PTC 模式自动可用。

---

## 8. 用户未提及、但应完善的方面

1. **任务状态机**：轮询 outputs，804/813 继续、0 成功、805 失败解析 `failedReason`（节点名/异常/traceback）；`wait:false` 仍可 `get_task` 找回。
2. **超时与重试**：`runTimeoutMs` 默认 60 分钟（仅计执行期）+ `queueTimeoutMs`（排队等待上限，默认不限）；网络瞬时失败有限重试；`exec.signal`/job cancel 时停止轮询并可调 `cancel`。
3. **webhook 可选**：`webhookUrl` 透传，与轮询并存。
4. **结果文件全覆盖**：图片预览、视频/音频播放/下载（ZIP 仅作为**输入**打包上传类型、非结果；若某工作流确实输出 ZIP 再单独支持）；URL 时效提示；下载入本地 + 自动 present。
5. **取消任务 + 队列状态**：封装 D 与 G；本地并发闸门 + FIFO 队列（§6.9）；`PENDING`/`QUEUED`/`RUNNING` 均可取消。
6. **高级参数透传**：`instanceType`（plus=48G）、`usePersonalQueue`、`retainSeconds`（10~180，企业共享 key）、`addMetadata`、`accessPassword`。
7. **`workflow` 直传**：`run_workflow` 的 `workflowJson` 参数可传完整工作流 JSON 覆盖 workflowId。
8. **原生 ComfyUI**：预留 gateway `raw` 分支（本期不实现）。
9. **LoRA 上传**：deferred，接口留位（取上传地址→上传→节点引用三步）。
10. **错误码中文提示**：401 key 不存在、814 队列满、805 失败等；`promptTips.node_errors` 结构化展示。
11. **安全**：apiKey 走 secret；日志/错误/payload 脱敏；缓存不存原文件字节。
12. **多账号**：deferred；v1 单 key，不在 `RunningHubConfig` 预建数组（需要时再改为 `accounts[]`）。
13. **label 约束**：唯一；建议短小易读（允许中文/空格，但推荐 kebab 或简短词，避免与工具/命令歧义）。
14. **i18n**：卡片与工具描述中英双语。
15. **测试**：gateway mock 覆盖 A~F 与状态码；映射/缓存单测（哈希命中、槽位不足报错、顺序分配）；设置卡片 + 聊天卡片 client spec；`plugin-config.e2e` 模式 e2e。
16. **文档**：包 README 按 `adding-a-package.md` 补 Model Experience / Known Limitations；skill 写清标准用法。

---

## 9. 分阶段实现计划

- **M1 骨架 + API Key + 设置卡片**：建包、挂载、settings 段（apiKey secret + 测试连接）。验收：GUI 出现 RunningHub 卡片，key 可存可测。
- **M2 工作流管理 + 测试**：添加(label)/拉取/解析、节点默认参数表 + 媒体槽位编辑、持久化、校验(免费)+真实测试运行。验收：拉取后能编辑参数、校验能报字段不存在。
- **M3 工具 + 提交/轮询/结果保存 + 后台 + 并发/排队**：list/fetch/run/get_task/cancel；create + outputs 轮询；`submittedPayload` 回传；结果下载（saveTo/filenamePattern）；`ctx.jobs.start` 后台分支 + 完成通知；本地并发闸门（默认 3，可改）+ FIFO 排队 + 排队/运行中可取消 + 60 分钟超时。验收：对话跑通、看到最终提交参数、后台运行不阻塞、结果落本地；并发超限自动排队、排队与运行中均可取消、超时可控。
- **M4 媒体上传缓存 + 映射 + 聊天卡片 + 缺参收集 + 失败可见**：内容寻址缓存、槽位顺序/校验、`needs_input`→`ask_user_question`、`tool.call.toolview` 卡片（含失败原因渲染）。验收：多轮复用不重复上传、映射不错、缺参能问、失败能看到原因。
- **M5 完善 + 启动自动恢复**：错误码/脱敏/超时/webhook/高级参数、i18n、测试、文档、skill 打磨；`apply` 阶段启动自动恢复（重查进行中任务结果 + 重投排队任务）。验收：重启后未终态任务自动续跑/续查、结果自动落本地。

---

## 10. 已确认决策与风险

**已确认（v2 全部关闭）：**
- 代码位置：DSH 仓库内（`packages/runninghub/dsh-runninghub`）。
- 媒体范围：图片 / 音频 / 视频 / 图片 ZIP。
- 结果本地保存：默认 `runninghub-outputs/`（会话工作目录），仅对话明确指定 `saveTo` 时切换。
- 缺参：`needs_input` → `ask_user_question` 收集后重跑（不提交不扣费）。
- 工作流 `label` + 默认工作流；测试 = 校验（免费）+ 真实测试运行。
- 后台运行不阻塞：默认 `wait:false`（`ctx.jobs.start` + 完成通知）。
- 失败可见：`failedReason` + `node_errors` 写入后台结果/`get_task`/聊天卡片。
- 结果可恢复：任务台账持久化；重启后**自动重查进行中任务结果 + 自动重投排队任务**，`list_tasks`/`get_task(taskId)` 作手动兜底。
- webhook：v1 不做主动（本地收不到回调），`webhookUrl` 仅作可选透传。
- 账号：单 API Key，结构留多 key 扩展位。
- 并发与超时：本地并发闸门默认 3（设置页可改，热改即时生效）、超过排队、排队/运行中可取消、执行超时默认 60 分钟（排队等待另设上限）。
- 媒体槽位：加 `required`（必填/可选），可选槽位缺则跳过；`viaUrl` 槽位本地文件自动上传转公网 `download_url`。
- 必填语义：必填 = 无默认值、运行时必须显式提供；校验只看「本次显式提供」，不用默认值兜底。
- 缓存：不存字节，但存 `sourceRef` 回源引用，fileName 失效回源重传；fileName 长期有效性待官方确认。
- 参数清单映射：`list_workflows`/`fetch_workflow` 返回 `params`（label→nodeId+fieldName），支撑模型翻译自然语言。
- owner：保留 `exec.agent`（会话隔离+完成通知）；owner/服务销毁走 teardown `cancel(reason)` 分支——不调平台 cancel、仅停本地轮询+落台账，任务在 RunningHub 继续跑。
- 统一 ID：`get_task`/`list_tasks`/`cancel_task` 同时接受 `taskId` 或 `jobId`。
- 台账：`TaskRecord` 增 `payload`（PENDING 重投用）与 `jobId`；后台成功自动 present 结果。
- 启动恢复：先恢复重查 RUNNING、再按 FIFO 重投 PENDING，均占并发槽位；重投前校验 fileName。
- 工作流更新：设置页「重新拉取」+ `refresh_workflow` 工具，重拉 RH 数据更新工作流定义（diff + 合并用户编辑）。

**主要风险：**
- `fileName`/`download_url` 有效期需实测；缓存已留 `sourceRef` 回源引用兜底，但回源不可达时仍会失败——`fileName` 长期有效性以官方为准。结果 URL 过期后需「重跑任务」而非「重拉结果」，故成功即下载很关键。
- DSH `constraints`/cookbook 已确认「普通包只能进一个 aggregate」——**已按双包拆分落地**（host `dsh-runninghub` + client `dsh-client-runninghub`），不影响功能。
- Web GUI 生效需重建产物并刷新（非纯 client 改动无法靠 HMR 自动生效）。
- 并发闸门为**本地（插件内）限制**，不改变 RunningHub 账号侧并发/队列（企业共享 key 的平台队列上限以平台为准）；本地 `PENDING` 队列在 DSH 重启后依赖台账重投（已持久化提交参数、未扣费，可安全重投）。

---

*方案已定稿，待你确认开工，我按 M1→M5 顺序实现，每阶段给可验证产物。*
