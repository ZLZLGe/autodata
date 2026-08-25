# AutoData

AutoData 是为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的外置 Bundle（扩展包）形式的自进化数据 Harness。它通过 Cordis 服务和工具扩展未经修改的 DSH 运行时，不把 DSH monorepo 作为 vendored 代码带入本仓库。

## 当前状态

`0.1.0-rc.1` 是第 1 阶段的 Bundle/生命周期验证版本，提供：

- `ctx.autodata`：确定性的内存状态服务；
- `autodata_status`：面向模型的只读 DSH 工具；
- 可安装的 `dsh.bundle.patch` 层；
- 覆盖安装、加载、可见性和销毁流程的 tarball/Profile 测试。

本阶段有意不实现轨迹处理、DataPlugin、进化控制、持久化、Python 训练和 GPU 评测。

## 阶段二（开发中）

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
动态任意代码加载、Controller、训练或 GPU。阶段二 Gate 通过后会暂停，另行
审批持久化和自进化 Controller。

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
