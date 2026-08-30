# AutoData

AutoData 是为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的外置 Bundle（扩展包）形式的自进化数据 Harness。它通过 Cordis 服务和工具扩展未经修改的 DSH 运行时，不把 DSH monorepo 作为 vendored 代码带入本仓库。

## 当前状态

`0.1.0-rc.1` 是当前候选版本，已完成阶段一 Bundle/生命周期验证和阶段二
内存 Core 验收，提供：

- `ctx.autodata`：确定性的内存状态服务；
- `autodata_status`：面向模型的只读 DSH 工具；
- 可安装的 `dsh.bundle.patch` 层；
- 覆盖安装、加载、可见性和销毁流程的 tarball/Profile 测试；
- canonical 轨迹、选择/quarantine、精确去重、DataPlugin pipeline 和
  logical training view；
- 深冻结的 DSH 上下文只读投影与插件生命周期事件。

阶段二保持纯内存、单进程、同步模型；Stage 3A 已增加持久化 Controller、
直接 JavaScript DataPlugin 提案、普通 Node 子进程验证、B_dev 接受/回滚和
重启恢复；Stage 3B 已用确定性 fake model 和真实 FreeRouter 模型分别驱动
DSH Agent/Session/Tool loop，并验证直接候选提交，Gate 3 已完成。Python 训练
和 GPU 评测由 [Stage 4A 兼容性闸门](docs/stage4a-gpu-gate.md) 接管；控制面与
离线测试已实现，正式 H200 train/eval 已于 2026-08-30 通过，Gate 4A 已完成。
Stage 4B 的 16-step H₀ 正式基线及 50-case BFCL 评测也已完成，B_dev 五类
等权 macro 为 0.8。Stage 4C 的原 FreeRouter run 在候选生成前因 provider
基础设施错误终止；其证据保持不变，当前通过追加式 PJLAB recovery 继续同一个
逻辑 H₁。详细实验记录与 artifact 证据保存在项目飞书实验台账。

## 阶段二（Gate 2 已完成）

阶段二在同一个 `ctx.autodata` Service 上增加内存 Core：调用方显式提供
source adapter、选择/quarantine 和运行元数据，Core 将记录转换为 canonical
trajectory，执行精确去重和 DataPlugin 选择流水线，并返回 logical training view
与计数摘要。

```ts
const result = ctx.autodata.run({
  harness_id: 'local-fixture',
  generation: 0,
  seed: 7,
  source: { dataset_id: 'fixture', dataset_revision: '1', records },
  source_adapter: adapter,
  selected_record_ids: null,
  quarantine_record_ids: [],
  plugin_ids: ['toolcall-h0'],
})
```

插件只允许选择或排序已有 `record_id`，不能改写轨迹。`ctx.autodata.plugins()`
返回不含执行函数的 descriptor；`ctx.autodata.context()` 返回深冻结的 DSH
只读上下文投影。`autodata_status`、`autodata_plugins` 和
`autodata_context` 是只读工具，DSH 仍然是 session、agent、tool executor 和
日志的唯一权威。

阶段二保持单进程、同步、内存模型，不写磁盘，也不引入锁、CAS、运行时哈希链、
动态任意代码加载、Controller、训练或 GPU。阶段二 Gate 已通过；其内存 Core
不负责 Stage 3 的持久化状态。

## 阶段三（Controller 与 DSH 动态候选）

Stage 3A/3B 按 [docs/stage3-evolution.md](docs/stage3-evolution.md) 实现：AutoData
使用 TypeScript/Node Controller 管理 TaskProfile、host-only JavaScript
DataPlugin 候选、B_search 反馈、子进程验证、B_dev 接受/拒绝、回滚和重启
恢复。生产 Bundle 使用 `AUTODATA_HOME`，未设置时回退到
`$DSH_HOME/autodata`；两者都缺失时会明确失败。强模型复用当前 DSH Profile
的 Agent、Session、Tool 和模型，直接提交 `host_source`；确定性 loop 与真实
FreeRouter smoke 均已通过。训练、评测和 GPU 作业通过 DSH `ctx.jobs` 在
Stage 4 接入。

### TaskProfile 初始化

人不必先写 TaskProfile。首次启动时，如果没有 `profiles` 配置且 Store 为空，
AutoData 会创建内置的 `default` Profile：benchmark 为 `autodata-fixture`，接受
指标为 `score`，候选能力为 `data-select`、`data-filter` 和 `data-order`。它用于
开箱验证；因为没有真实 B_dev 报告，候选最多保持 `validated/open`，不会自动
冒充已接受版本。

正式 benchmark 应由 Host 在 DSH Profile 的 `cordis.patch.yml` 中覆盖
`autodata-service` 配置，例如：

```yaml
- id: autodata-service
  config:
    profiles:
      - id: bfcl-v4
        benchmark: bfcl-v4
        acceptance:
          metric: equal_category_accuracy
        capabilities:
          - data-select
          - data-filter
          - data-order
```

显式 `profiles` 列表不会额外创建 `default`；`strategy_plugin_id` 省略时默认为
`<profile-id>-strategy`。Profile 创建后不可变，相同配置重启会复用已有状态，
修改 benchmark、指标、能力或策略 ID 必须使用新的 Profile ID。配置不会删除
Store 中已有的历史 Profile，模型也没有创建或修改 Profile 的工具。

## Stage 4A（H200 兼容性闸门）

Stage 4A 是 Host-only API，不进入 `ctx.autodata`、模型工具列表或 capability
清单。它固定执行四卡 H200、两步 Qwen3.5-9B 全参训练，再以单卡 H200、固定
vLLM/BFCL 配置验证五个冻结 case。每一阶段严格按 RJob dry-run、predict-only
`1/1`、submit 的顺序执行，并以确定性 RJob 名和原子 `state.json` 支持重启恢复。

调用、状态目录、取消语义、依赖准备和真实执行前检查见
[docs/stage4a-gpu-gate.md](docs/stage4a-gpu-gate.md)。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm 11
- DeepSeek Harness `0.1.1-rc.2`

## 开发

```sh
corepack enable
pnpm install
pnpm check
```

`pnpm test:profile` 会在临时目录中构建包 tarball，将其安装到隔离的 DSH Profile（配置档案）中，验证服务和工具，并确认关闭时能够干净销毁。它不会调用模型 API。

真实模型 smoke 是显式选择加入的本地检查，不属于 `pnpm check`：

```sh
FREEROUTER_API_KEY=... pnpm smoke:freerouter
```

该命令通过 DSH 的 `llm-pi-ai`、Agent、Session 和 Tool loop 调用固定的
`free-router/gpt-5.6-sol` 路由，从 synthetic B_search 反馈生成并验证一个
DataPlugin 候选。凭据只通过 `FREEROUTER_API_KEY` 环境变量引用；脚本不读取
`auth.json`。变量缺失或为空时命令会在加载 Agent/模型适配器之前跳过并以 0
退出，不会发出网络请求。普通 `pnpm check` 只做离线配置和跳过路径验证，不能
据此声称真实模型 smoke 已通过。若进程环境设置了标准 `HTTP_PROXY`、
`HTTPS_PROXY` 或小写等价项，smoke 会让 Node 请求遵循这些代理及 `NO_PROXY`；
代理地址和凭据都不会写入结果。DSH 的默认有限重试策略会处理瞬时超时、限流和
传输错误。失败只打印脱敏后的稳定错误码与消息；成功 JSON 会记录工具调用顺序、
候选状态和版本、实际启动的重试次数，以及所有 provider attempt 已报告的汇总
token usage。

Stage 4C 当前 Evolver 路由使用 PJLAB 的 OpenAI-compatible Chat Completions
接口；独立的连通性检查为：

```sh
PJLAB_API_KEY=... pnpm smoke:pjlab
```

该检查固定调用 `pjlab/glm-5.3-flash`，通过真实 DSH Agent loop 验证 SSE 与
Stage 4C 使用的 `max_tokens=16384`，但只发送无候选上下文的 `Reply with
exactly OK.`。密钥只从 `PJLAB_API_KEY` 读取，不写入配置或结果；它不创建
generation、candidate 或 experiment，也不计作正式 H₁ 草稿。成功摘要会明确
报告实际 provider attempt 与 retry 数量。

正式恢复先在无模型请求的 `prepare` 步骤中校验原失败 run、冻结 H₀、
Evolution 状态和模型可见上下文，并创建唯一、追加式协议修订；之后才允许启动：

```sh
pnpm stage4c:first-h1 prepare
PJLAB_API_KEY=... pnpm stage4c:first-h1 start
PJLAB_API_KEY=... pnpm stage4c:first-h1 resume
```

恢复 generation 使用独立的
`/data/codex-work/autodata/runs/generation-recoveries/stage4c-pjlab-01`
根目录；原 FreeRouter claim、run 和三次失败 response 不会被删除或改写。

## 安装本地候选版本

先构建 tarball，再通过 DSH 安装：

```sh
pnpm pack
dsh plugin --profile autodata add ./zlzlge-autodata-0.1.0-rc.1.tgz
dsh --profile autodata --dump-config
dsh --profile autodata
```

`autodata` Profile 适合用于验证 Bundle。需要交互式界面时，将 Bundle 安装到 `web`；需要一次性任务时，将其安装到 `headless`。

npm 包名配置为 `@zlzlge/autodata`，但目前尚未发布。发布后，安装方式为：

```sh
dsh plugin --profile web add @zlzlge/autodata
dsh --profile web --dump-config
dsh --profile web
```

## 架构边界

DSH 负责 Agent loop、会话日志、提示词组装、工具运行时、审批、沙箱和 Bundle 加载。AutoData 只负责自身的数据处理和进化能力。长期演化的状态是 AutoData 的 `DataPlugin` 图，而不是 DSH 运行时。

## 许可证

MIT
