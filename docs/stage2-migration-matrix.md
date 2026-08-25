# AutoData Stage 2 Core 迁移矩阵

状态：已确认，Gate 2 已完成（2026-08-26）。本文档记录阶段二的可执行边界
和验收结果；不授权自动进入阶段三。

## 目标

Stage 2 在现有 `ctx.autodata` Bundle 中加入一个独立的、内存中的数据领域 Core。Core 只负责把明确提供的源记录转换为 canonical trajectory、selection 和 logical training view，并管理受信任的 DataPlugin 注册生命周期。

DSH 仍然拥有 Agent loop、Session、工具注册和工具执行。AutoData 不复制这些运行时，也不建立第二套 session、日志或 tool executor。

## 迁移矩阵

| 旧 DataHarness 语义/模块 | Stage 2 处理 | 具体边界 |
| --- | --- | --- |
| `types.ts` 中的 canonical trajectory、source reference、selection、plugin decision | 保留并重写 | 迁移到 `src/core/types.ts`，改用 AutoData 的错误和命名；不带持久化路径或完整性字段。 |
| source adapter 的 `identify()` / `adapt()` | 保留并重写 | 每次 run 显式传入 adapter；Stage 2 不建立 adapter 自动发现或动态安装注册表。 |
| canonical 结构校验、角色/工具调用校验、warning 统计 | 保留并重写 | 输入在 adapter 边界 detach/freeze；warning 只进入内存 run summary。 |
| `selected_record_ids` 的顺序选择 | 保留 | `null` 表示按源顺序处理全部记录；非空 ID 列表保留调用方顺序；缺失 ID 明确失败。 |
| `quarantine_record_ids` | 保留 | 在 canonical 化前跳过被隔离记录；隔离记录不要求通过 adapter 内容校验。 |
| canonical 内容的精确去重 | 保留，限定为内存操作 | 使用规范化内容作为本次 run 的临时 Set key；不计算、不保存、不暴露 SHA、hash chain 或其他完整性 hash。 |
| DataPlugin 只能选择/排序已有 `record_id` | 保留并强化 | 输入和 run context 深冻结；输出只能是唯一的已有 ID 加可选 note，禁止新增、改写轨迹或权重。 |
| plugin provenance | 保留 | 每个 surviving selection 记录插件 `id`、`version` 和可选 note；顺序由请求的 `plugin_ids` 决定。 |
| H0 baseline plugin | 保留 | 内置 `toolcall-h0`，只做 identity selection；注册表列表按 ID 排序，pipeline 不按注册顺序隐式排序。 |
| logical training view（assistant prefix/loss 标记） | 保留并重写 | 继续输出 model-independent logical units；tokenizer、template、trainer 不进入 TypeScript Core。 |
| `DataHarnessService` | 不原样复制 | 由当前 `AutoDataService` 承载同一套 `register()`、`plugins()`、`run()` API；不注册第二个并行 Service。 |
| Cordis 生命周期 | 保留 DSH 机制 | plugin 注册使用调用方 fiber 的 effect；显式 disposer 幂等且只删除自己注册的 exact snapshot。Agent scope 下的候选变更暂不允许，留给 Stage 3 Controller。 |
| `runner.ts` 的内存计算 | 选择性迁移 | 只迁移 source→canonical→selection→logical view 主链；输出为内存对象和 summary。 |
| `store.ts` 普通文件持久化 | 删除（Stage 2） | 不写 `AUTODATA_HOME`、run directory、JSONL artifact 或 checkpoint；持久化另在获批阶段设计。 |
| invariant companion、CAS、完整性锁、expected SHA、hash chain | 删除 | 这些机制没有 Stage 2 的业务收益，也不作为运行时协议恢复。 |
| 独立 session/log、重复 tool executor、重复 patch 校验 | 删除 | DSH 已提供权威实现；AutoData 只能观察其只读投影或注册自己的工具。 |
| Python、ms-swift、GPU、训练和评测 | 延后 | 通过 Stage 4 外部 adapter/job 接入，不进入本阶段包。 |

## Stage 2 公共 Core 契约

公共类型和错误位于 `src/core/types.ts` 与 `src/core/errors.ts`，并已由
`AutoDataService` 实现：

```ts
ctx.autodata.register(plugin): disposer
ctx.autodata.plugins(): readonly DataPluginDescriptor[]
ctx.autodata.run(request: RegisteredDataRunRequest): DataRunResult
ctx.autodata.context(request?): DataContext
```

约束如下：

- `DataPlugin.run` 保持同步；输入 selection 和 `DataPluginContext` 都是深冻结快照。插件是同进程受信任扩展，冻结不等于 sandbox。
- `run` 的 `plugin_ids` 解析和 snapshot 在消费 source 之前完成。一次 run 中途发生注册/卸载不会改变本次 pipeline。
- registry 失败或 plugin 失败不改变 registry 中已有的插件；未知/重复 ID、非法 decision、空 selection 都返回带稳定 `code` 的 `AutoDataCoreError`。
- `DataRunSummary` 只记录 schema/source/plugin/count/warning 元数据，不包含输入 ID 列表、文件路径、时间戳、随机生成 ID、hash 或锁状态。
- `DataContext` 只是 DSH 运行时的深冻结结构快照：可选的 session `{id, seq}`、agent `{id, status}`、workspace 元数据、当前 scope 可见 tool schemas，以及 AutoData plugin descriptors。它不暴露 `ctx`、session/agent 方法、tool `execute` 或第二个 executor。
- sessions、agents、workspace 未安装时表示为 `undefined`，不能伪装成“空列表”；tool schemas 从调用方 scope 的 DSH `ctx.tools.schemas(scope)` 取得。

## 工具和事件边界

Stage 2 保留 `autodata_status`，并增加只读 `autodata_plugins` 与
`autodata_context` 工具用于列出 descriptor 和查看上下文；`autodata_run`
不作为模型工具暴露，直到 source registry、权限和 Controller 边界确定。
所有工具继续使用 DSH `ctx.tools.register()` / `ctx.tools.execute()`。

可提供最小的 Cordis live notification：`autodata/plugin-registered`、`autodata/plugin-unregistered`、`autodata/run-started`、`autodata/run-completed`、`autodata/run-failed`。事件只携带 descriptor、run metadata、counts 或错误 code；它们不是 session log，也不是事务回滚协议。listener 失败必须被 containment，不能改变已提交 registry 或 run result。

## Gate 2 验收

Gate 2 通过前必须完成以下证据：

1. Core public types/errors 导出、typecheck 和 API 文档。
2. canonical、selection/quarantine、精确去重、plugin provenance、logical view 的小型 fixture parity 测试。
3. H0、排序、重复/未知插件、exact disposer、fiber unload、输入 mutation、非法 decision、plugin throw、empty output 测试。
4. `DataContext` 的 optional service、agent/session/workspace snapshot、scope tool schema、deep freeze、无 live method 测试。
5. event post-commit、listener dispose、listener failure containment、reentrant registration 测试。
6. `autodata_status` 兼容、只读工具 schema/execute、tarball/Profile smoke，以及 Node 22/24 CI。

Gate 2 结束后停止，不自动进入 persistence、Controller/Evolver、Python 或 GPU；这些内容需要另一个阶段门和明确批准。

## 仍需审批的决策

- 是否接受 `AutoDataService` 承载 registry，而不是新增 Service。
- 是否保持 Stage 2 Core 纯同步、单进程、内存模型。
- 是否只允许 host/plugin context 注册 DataPlugin，禁止 agent scope 直接改变共享 registry。
- 是否在本阶段加入 `autodata_plugins`（推荐）而把 `autodata_context` 保持为 host API。
- Stage 2 candidate 版本使用 `0.2.0-rc.1` 还是继续 `0.1.0-rc.*`；版本变更应在 Gate 2 验证后单独提交。

## 当前执行记录

截至 2026-08-26，仓库已实现并验收 Core 的完整阶段二链路：严格 JSON/canonical
边界、OpenAI tool-trajectory adapter、选择/quarantine、内存精确去重、
DataPlugin pipeline、provenance 和 logical training view；`ctx.autodata`
已提供注册表、运行 API、深冻结 DataContext、最小 typed events，以及
`autodata_status`、`autodata_plugins`、`autodata_context` 只读工具。

已验证：typecheck、27 项单元/fixture/lifecycle 测试、Node 22/24 Profile/tarball
smoke 和 npm pack。新增验证覆盖旧 DataHarness fixture parity、插件重入和
exact disposer、事件监听器失败 containment 与卸载、可选 DSH 服务缺失、
agent-scoped 只读上下文，以及服务边界的未知/非法 run 请求。

阶段二明确没有实现持久化、Controller/Evolver、动态候选代码、Python/ms-swift、
训练、评测或 GPU；这些仍由后续阶段门控制。Gate 2 完成后停止，等待用户单独
批准阶段三。
