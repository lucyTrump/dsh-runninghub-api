# RunningHub 插件独立化可行方案

> 日期：2026-09-11
> 现状基准：`deepseek-harness` 分支 `runninghub-api`，commit `b837b11ede`（唯一改动提交）
> 目标：`/Users/lucytrump/test-temp/dsh-runninghub-api` 独立仓库 → GitHub → DSH 插件市场安装/更新
> 原始设计文档：同目录 `DESIGN.md`（v3，以代码实现为最终基准）

---

## 0. 结论（TL;DR）

**可行，且生态已经存在。** 不需要给 DSH 提任何 PR，master 保持零入侵：

- DSH 官方支持仓外插件：`dsh plugin --profile web add <包名|github:owner/repo|tarball>`（pnpm 转发 + 声明 `dsh.bundle` 的包自动进入 profile 层叠）。官方教程：`docs/user/develop/basic/publish.md`。
- 「DSH 插件市场」已存在且你已安装：`dshmarket`（npm 包名）——设置页内浏览/一键安装/更新社区插件，上架走策展注册表 awesome-dsh-plugin。
- **你自己的 `dsh-image-api`（`/Users/lucytrump/test-temp/python-api-runner`）就是仓外"单包双面"（host + 浏览器客户端）插件的已验证模板**，本机 web profile 正在用。

runninghub 需要 **3 处实质改动**（详见 §4）：包改名与清单改写、客户端自挂载 remote（替代对 `api-remotes` 的仓内修改）、独立构建链（含 Typert 产物再生成）。**全部已实现功能可保留**（对照表见 §5）；用户数据无需迁移（§6）。有 4 个点需要你确认（§9）。

---

## 1. 现状盘点

`b837b11ede` 的全部内容：

| 部分 | 内容 |
|---|---|
| `packages/runninghub/dsh-runninghub/`（host 半） | settings 命名空间 `runninghub`、RunningHub API gateway（create/status/outputs/cancel/上传/object_info 缓存）、7 个 `runninghub.*` 工具、任务台账（跨重启恢复）、媒体内容哈希缓存、并发闸门+FIFO 排队、Typert remote（设置卡片 RPC）、内置 skill |
| `packages/runninghub/dsh-runninghub-client/`（client 半） | 设置卡片（`settings.plugin.item`）+ 聊天工具卡片（`tool.call.toolview`），React，中英双语 |
| **仓内接线（4 处，全部要拆掉）** | ① `packages/api/remotes/src/client/index.ts` 挂载 `runninghubRemote`；② `packages/bundle/web-app/cordis.patch.yml` 两行 insert；③ `packages/bundle/web-app/package.json` 两个依赖；④ 根 tsconfig references + pnpm-lock |

仓内接线①是唯一"侵入他包"的修改，②③④只是挂载。外部化后 4 处全部不需要。

## 2. 机制调研结论（均已读源码或本机验证）

| 机制 | 证据 | 对仓外插件的意义 |
|---|---|---|
| profile = `$DSH_HOME/profiles/<name>/`：package.json（依赖 + `dsh.profile.bundles`）+ 用户 `cordis.patch.yml` | `packages/boot/app-boot/src/profile.ts` | 插件装进 profile，不动 DSH 本体 |
| `dsh plugin` = pnpm 转发器；声明 `dsh.bundle.patch` 的包自动加入层叠 | `apps/cli/src/plugin.ts` | 安装/更新 = `add` / `update`，一行命令 |
| 模块解析双锚点：profile 的 node_modules 优先，`$DSH_HOME/profiles/node_modules` 兜底（含安装闭包、含 peer），保证 cordis 等单例 | `profile.ts` BFS 逻辑；**本机 fallback 目录已确认含全部所需包**：cordis、dsh-tools、dsh-jobs、dsh-skill、dsh-settings、dsh-credentials、dsh-home-paths、dsh-typert-protocol、dsh-util-values、schemastery、zod | host 半的 peer 依赖全部能解析到 DSH 安装的单例 |
| Loader 以 profile 目录为 `baseUrl` 解析裸包名 | `apps/cli/src/profile-boot.ts` | bundle patch 里的 `name: '<包名>'` 直接解析到 profile 已装包 |
| **客户端运行时发现**：`dsh-client-modules` 扫描 Loader 树中带 `dsh.client` 声明的包，运行时组 `window.__DSH_BOOT__`、按需伺服 `/plugins/<id>/client.js` | `packages/client/modules/src/index.ts` | client 半**不需要改 web-app**——行插进树里就被看到 |
| **Typert 自动注册**：`dsh-typert-loader` 对每个挂载条目解析其 package.json，有 `./typert` 导出就导入注册 | `packages/typert/loader/src/index.ts` | host 半的 remote 端点**自动上线**，无需接线 |
| `ctx.remote.$mount()` 是公开 API | `packages/api/gateway/src/client/index.ts`（`$mount` 方法） | client 半可**自己挂载** runninghub remote，替代对 `api-remotes` 的仓内修改 |
| 生成的 `/remote` 产物自带 `TypertRemoteNamespaceMap` 声明合并 | `lib/typert.remote-client.d.ts` | 自挂载后 `ctx.remote.runninghub` 的类型自动成立 |
| 市场安装偏好：**npm 包 > GitHub Release 预构建 tarball > git 源码**（源码需 `prepare` + 用户在 `pnpm-workspace.yaml` 加 `allowBuilds`） | dshmarket README + `publish.md` | 推荐发 npm；git 源码安装有摩擦 |
| 市场兼容性展示读 `engines.dsh` 或 lockstep `@deepseek-ai/dsh-*` peer 范围 | dshmarket README | 清单里要声明 |

## 3. 目标形态（单包，推荐）

先例：`dshmarket`、`dsh-image-api` 都是**一个包同时是 host 插件和 client 插件**（`dsh.bundle` + `dsh.client` 写同一 manifest，patch 只插一行）。比现在的双包更简单，安装一步到位。

```
dsh-runninghub-api/
├── package.json            # name: dsh-runninghub-api；dsh.bundle + dsh.client
├── cordis.patch.yml        # - insert: [{ id: runninghub, name: dsh-runninghub-api }]
├── tsdown.config.ts        # 仓外双构建（照 dsh-image-api 模式）
├── tsconfig.json / tsconfig.host.json
├── src/                    # 现 dsh-runninghub/src 原样搬入
│   ├── index.ts  gateway.ts  rpc.ts  runner.ts  tools.ts  …
│   └── client/             # 现 dsh-runninghub-client/src/client 原样搬入
├── tests/                  # 现 5 个 vitest spec 原样搬入（纯单测，无仓内耦合）
├── README.md / README.zh.md
└── .github/workflows/      # build + 冒烟 + release
```

两个包名注意点：

- npm 上 `dsh-runninghub` 是否被占用要查；`dsh-runninghub-api` 与目录同名、最直观。最终你定。
- 包名改了，但**产品标识全部不变**：settings 命名空间 `runninghub`、工具名 `runninghub.*`、skill 名、数据目录 `~/.dsh/runninghub/`、credential 引用 `RUNNINGHUB_API_KEY` —— 用户数据和模型习惯完全连续。

## 4. 必须做的 3 处改动

### 4.1 package.json 重写（配置改动，无逻辑变化）

- `name`：改为你的包名（`@deepseek-ai/*` 你没有发布权限，**必须改**）。
- `workspace:^` → 真实 semver 范围。参照 dshmarket 写法：`"@deepseek-ai/dsh-tools": "^0.1.5-rc.2"` 等（`^0.1.5-rc.2` 覆盖后续 rc 与 0.1.x 正式版）；加 `"engines": { "dsh": ">=0.1.5" }` 供市场展示。
- 新增 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...保持现有4项], "platform": "web" } }`。
- `exports`：`.`（host 入口）、`./client`（浏览器 bundle）、`./typert`、`./remote`、`./types`、`./cordis.patch.yml`、`./package.json`。
- `zod` 保留在 `dependencies`（生成的 Typert 产物运行时 `import { z } from 'zod'`）；`@deepseek-ai/schemastery` 建议从 dependencies 移到 peerDependencies（dshmarket 模式：交给安装单例，避免双副本）。
- `files`：`lib`、`cordis.patch.yml`、README。

### 4.2 客户端自挂载 remote（**唯一的运行时行为改动**）

现状：仓内改过的 `api-remotes` 装配在启动时挂载 `runninghubRemote`，卡片插件 `inject` 里声明 `remote.runninghub`。

改为（卡片插件自己的 `apply` 里）：

```ts
import runninghubRemote from 'dsh-runninghub-api/remote'   // 生成的贡献，打进 client bundle

export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.credentials']
// 注意：去掉 'remote.runninghub'（自己挂载的服务不能注入自己）

export async function apply(ctx: ClientContext) {
  await ctx.remote.$mount(runninghubRemote)   // 挂上后 ctx.remote.runninghub 即可用，类型由 /remote 产物的声明合并自动提供
  // …其余注册逻辑不变
}
```

- `remote.credentials`（写 API key 用）由仓内 `settings-controller` 提供，任何 web profile 都有，不受影响。
- 行为等价，但需要回归测设置卡片 4 个动作：拉取工作流 / 校验 / 测试连接 / 真实测试运行。

### 4.3 独立构建链

照抄你自己 `dsh-image-api` 的 `tsdown.config.ts` 模式（它逐条复刻了仓内 `packages/client/tsdown.client.ts` 的契约）：

1. **host 半**：`src/index.ts` → ESM `lib/index.js`（tsdown，platform node）。
2. **client 半**：`src/client/index.ts` → CJS factory `lib/client.js`，banner/footer 包装 `window.__ModuleLoader__.load({id, factory})`；externals = 种子表（react、cordis、dsh-client-store、ui-slots、ui-primitives、ui-dockkit），其余全部内联（clsx、`/remote` 生成代码、zod）。CSS Modules 用 lightningcss 内联（dsh-image-api 没用到 CSS，runninghub 有 3 个 `.module.css`，需要把仓内 preset 里的 CSS 插件段抄过来——约 60 行，现成可搬）。
3. **Typert 产物**（`typert.host.js` / `typert.remote-client.js`）：仓内由 `@deepseek-ai/dsh-typert-generator` 的 tsdown 插件在工作区模式生成。仓外方案：
   - **首选**：generator 作 devDependency，`typertPlugin({ mode: 'package', faces: ['host'] })`；它向上找 `tsconfig.host.json` 定位"工作区根"，仓里放一个只含本包的最小 face 配置即可。**此路径未实测，列为 M0 验证项。**
   - **兜底**：把生成产物提交进仓（它们只在 `rpc.ts` 的 RPC 面变化时才变）。注意生成器有 `TYPERT.package === 包名` 的硬校验，改名后必须重新生成或机械替换产物内的包名字符串。

## 5. 功能保留对照表

| 现有功能 | 外部化后 | 说明 |
|---|---|---|
| 设置卡片（API key/工作流管理/参数表/媒体槽位/校验/测试运行/重新拉取） | ✅ 保留 | 走 `settings.plugin.item` 槽位 + 自挂载 remote（§4.2） |
| 7 个模型工具（list/fetch/refresh/run/get/cancel/upload） | ✅ 保留 | `ctx.tools.register`，与包位置无关 |
| 提交参数可见（最终 payload 回传 + 聊天卡片） | ✅ 保留 | `tool.call.toolview` 槽位 |
| 媒体上传缓存（sha256 内容寻址） | ✅ 保留 | 纯 host 逻辑 |
| 后台任务（dsh-jobs）+ 完成通知 | ✅ 保留 | `ctx.get('jobs')`，安装闭包提供 |
| 并发闸门 + FIFO 排队 + 超时 + 取消 | ✅ 保留 | 纯 host 逻辑 |
| 任务台账 + 重启自动恢复 | ✅ 保留 | 落盘 `~/.dsh/runninghub/`，与包位置无关 |
| 内置 skill | ✅ 保留 | `ctx.get('skills')?.register` |
| 中英双语 | ✅ 保留 | 卡片区 locale 注册是运行时机制 |
| 单元测试（5 个 spec） | ✅ 保留 | 纯 vitest，只 import `../src`，零仓内耦合 |

## 6. 数据连续性（无需迁移）

全部状态都在仓库之外，外部包装好后直接接着用：

- 设置（含工作流定义）：`$DSH_HOME` 的 settings 文件，按命名空间 `runninghub` 存 —— 不变。
- API key：credentials 域 `RUNNINGHUB_API_KEY` 引用 —— 不变。
- 任务台账 / 媒体缓存：`~/.dsh/runninghub/` —— 不变。
- 已下载产物：各会话目录 `runninghub-outputs/` —— 不变。

## 7. 风险与限制（如实声明）

1. **DSH API 是预稳定的**（官方明示 pre-stable）。仓外插件失去"API 变了编译器立刻红"的保护，每次 DSH 升级要跑一遍冒烟（装包 → 卡片四动作 → 跑一个真工作流）。缓解：peer/engines 范围声明 + 市场会展示兼容性 + 在 CI 里对 released dsh 版本做安装冒烟。
2. **Typert 仓外生成未实测**（§4.3）。是整个方案唯一的技术未知点，所以排 M0 最先验证；兜底路径已备好。
3. **git 源码安装有摩擦**：pnpm≥10 默认不跑 `prepare`，用户要在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds`（官方文档原话）。发 npm 或 Release 预构建 tarball 可完全避开 —— 推荐 npm。
4. **市场上架要过策展**：`dshmarket` 只允许安装 awesome-dsh-plugin 注册表里的来源。上架需向其提交（流程在该项目的 GitHub；我本机网络被沙箱挡住，提交细则未查到，实施时查）。不上架也能用 `dsh plugin add` 手动装。
5. **开发体验略降**：没有仓内 HMR/断点套件。日常回环 = 仓里 `pnpm build` → `dsh plugin --profile web add ./dsh-runninghub-api`（link 安装，reconcile 认 link）→ 重启或靠 live patch 重载。
6. **Electron 桌面端**：机制支持外部插件，但本插件 `platform: web` 未测桌面，先声明 web only。
7. **过渡期互斥**：不要在「runninghub-api 分支 checkout」和「外部包」之间同时挂载同一 profile —— 行 id 相同会按层叠互相覆盖，行为会变得难猜。验证外部包时从 master 启动。

## 8. 实施计划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0** 最大未知先行 | 在外部仓跑通 Typert 生成（generator devDep + 最小 `tsconfig.host.json`）；不通则落地兜底（提交生成产物 + 改名替换脚本） | `lib/typert.host.js` / `typert.remote-client.js` 生成且 `TYPERT.package` 为新包名 |
| **M1** host 骨架 | 搬 src/tests；package.json；tsdown host 构建；`dsh plugin --profile web add .`；`--dump-config` 看层 | 工具出现在会话（`runninghub.list_workflows` 可调），单测全绿 |
| **M2** client | CSS 插件段搬入；client 构建；§4.2 自挂载改动；刷新页面 | 设置卡片出现且四动作全通；聊天卡片渲染提交参数 |
| **M3** 全链路回归 | 真 key 跑真实工作流：上传缓存命中、后台任务、并发排队、取消、台账恢复（杀掉 dsh 重启） | 对照 DESIGN.md §6 全过 |
| **M4** 发布与上架 | GitHub 仓推送；npm publish（或 Release tarball）；`dsh plugin add <npm名>` 干净机安装；提交 awesome-dsh-plugin 注册表；验证市场内安装与更新 | 全新 profile 一键装；市场卡片可见可更新 |

## 9. 需要你确认的 4 个决策

1. **包名**：`dsh-runninghub-api`（与目录同名，推荐）？还是 `dsh-plugin-runninghub` / 你的 scope？
2. **单包**（推荐，dshmarket 与你的 dsh-image-api 均为此形态）还是维持 host/client 双包？
3. **发布渠道**：npm（推荐，市场首选源、用户零摩擦）？还是仅 GitHub（Release 传预构建 tarball 也可免构建；直接 git 源码安装有 allowBuilds 摩擦，不推荐作为唯一渠道）？
4. **版本与母版**：外部仓从 `0.1.0` 起；迁移完成后 `runninghub-api` 分支作废、外部仓为唯一开发母版 —— 同意吗？

---

*方案调研基于：DSH 源码（`apps/cli/src/plugin.ts`、`packages/boot/app-boot/src/profile.ts`、`packages/client/modules`、`packages/typert/loader`、`packages/api/gateway`）、官方文档 `docs/user/develop/basic/publish.md`、本机 `~/.dsh/profiles/web/` 实装状态（dshmarket 1.45.1 / dsh-plugin-playwright 0.2.0 / dsh-vision-router 2.1.5 / dsh-image-api link）、本机已构建产物。*
