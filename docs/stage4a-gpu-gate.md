# Stage 4A GPU 兼容性闸门

Stage 4A 验证 AutoData 物化数据能否完成固定的 Qwen3.5-9B 全参训练与 BFCL
工具调用评测。当前仓库已实现控制面、worker、冻结样例和离线验证；正式 H200
train/eval 已于 2026-08-30 通过，Gate 4A 已完成。详细实验记录与 artifact 证据
保存在项目飞书实验台账。

## 边界与固定协议

- API 只供可信 Host 调用：`startStage4A`、`statusStage4A`、`cancelStage4A`、
  `resumeStage4A` 和 `getStage4AController`。它们不挂到 `ctx.autodata`，也不注册
  模型工具。
- train 固定使用 4 张 H200、Qwen3.5-9B revision
  `c202236235762e1c871ad0ccb60c8ee5ba337b9a`、全参 bf16、Adafactor、ZeRO-3 和
  2 个 step。`max_length=8192`，ms-swift 参数使用 `truncation_strategy=delete`；
  它会把超长 unit 排除并在 template 层映射为禁止截断的 `raise` 行为。
- eval 固定使用 1 张 H200、vLLM `0.19.1`、`qwen3_coder` parser 和仓库内五个
  BFCL case。
- 每个阶段严格执行 `rjob submit --dry-run true`、
  `rjob submit --predict-only true`（必须报告 `1/1`，或新版 CLI 等价的总数 1、
  可调度 1、不可调度 0），最后才正式 submit。远端
  入口始终是 `/bin/bash <staged-script>`，不使用 shell 拼接命令。
- RJob 固定使用 `cl4mind_gpu` charged group、`group` private-machine、非抢占、
  `backoff_limit=1`，并挂载用户 GPFS 与公共模型 GPFS。`--metadata-name` 与
  确定性 RJob 名相同，`--name` 只作为 showname；恢复和取消始终按 metadata name。
- Stage 4A 只验证兼容性，不调用 Stage 3 的 `recordEvaluation()`，也不修改
  active/champion。

Bundle patch 只声明 `autodata-service` 注入已有的 `jobs` 与 `subprocess` 服务；
DSH 基础配置负责装配 local provider，AutoData 不重复注册实现。

## 持久化与恢复

默认路径为：

```text
/data/codex-work/autodata/runs/<profile>/<run>/
/mnt/shared-storage-user/gezhilong/autodata/staging/<run>/
```

本地 run 目录中的首个 `state.json` 与 canonical JSONL、logical view、run summary
一起原子发布。GPFS staging 使用这些本地文件幂等重建；如果初始化中断，状态保持
`initializing`，可直接 `resumeStage4A()`。attempt 成功状态与对应 result path 在
同一次原子状态写入中提交。

DSH `JobId` 只在当前进程中用于查看和取消，不写入 `state.json`。跨进程恢复使用
确定性 RJob 名 `autodata-<run-id>-<train|eval>`。如果提交响应丢失或提交期间取消
无法确认远端是否已创建，状态进入 `recovery_required`；恢复只检查该确定性名称，
绝不盲目重复提交 GPU 作业。

## Host 调用

```ts
import {
  cancelStage4A,
  resumeStage4A,
  startStage4A,
  statusStage4A,
} from '@zlzlge/autodata'

const started = startStage4A(ctx, {
  profile_id: 'bfcl-v4',
  run_id: 'gate-20260830-01',
  data_run: materializedDataRun,
})

const current = statusStage4A(ctx, 'bfcl-v4', 'gate-20260830-01')
await cancelStage4A(ctx, 'bfcl-v4', 'gate-20260830-01')
resumeStage4A(ctx, 'bfcl-v4', 'gate-20260830-01')
```

`run_id` 同时进入 GPFS 路径和 RJob 名，必须在并行运行之间保持全局唯一。

## 真实 H200 前置检查

训练脚本要求已有、非空的 ms-swift wheelhouse：

```text
/mnt/shared-storage-user/gezhilong/dataharness/dependencies/ms-swift-4.5.2-py311-torch2.7-cu128-v3/wheelhouse
```

评测脚本要求 BFCL wheelhouse，以及新的 AutoData vLLM wheelhouse：

```text
/mnt/shared-storage-user/gezhilong/dataharness/dependencies/bfcl-eval-2026.3.23-py311/wheelhouse
/mnt/shared-storage-user/gezhilong/autodata/dependencies/vllm-0.19.1-transformers-5.15.1-py311-cu128/wheelhouse
```

旧 DataHarness 路径当前不应被删除或覆盖。备份 wheelhouse 位于：

```text
/data/codex-work/dataharness/dependency-audit/vllm-0.19.1-transformers-5.15.1-py311-cu128-wheelhouse
```

真实作业前应以可校验、非破坏方式恢复到 AutoData 路径，然后依次观察 train 的
dry-run、predict-only、submit 和结果；train 通过后，再对 eval 重复相同顺序。
真实结果与 artifact 证据写入项目飞书实验台账，不把运行产物提交到 Git。

## 离线验证

```sh
pnpm run typecheck
pnpm exec vitest run tests/stage4a.spec.ts tests/stage4a-local-integration.spec.ts
pnpm run test:python
bash -n stage4a/train.sh stage4a/eval.sh
```

local-provider 集成测试使用真实 `dsh-jobs-local` 与 `dsh-subprocess-local`，但用
临时 fake `rjob` 可执行文件代替集群；它不申请 GPU，也不等价于真实 H200 验证。
