# AutoData Stage 3 Evolution

状态：已确认，按 2026-08-26 最终方案执行。

本文档是 AutoData Stage 3 的可执行边界。它替代本仓库和飞书中较早的
`cordis_define` 草稿链路、`active.json` 双指针以及隔离型 Validator 方案。
Python、训练、GPU 和真实 Evaluator 仍属于 Stage 4。

## 产品与 DSH 边界

AutoData 继续以单一 `@zlzlge/autodata` Bundle 发布。DSH/Cordis 是 Profile、
Agent、Session、Tool、Event、Dynamic Package、Job 和模型运行时的权威；
AutoData 不 fork DSH，不另建 Agent、Session、Tool Executor 或模型客户端。

Stage 3 只演化受信任的 host-only JavaScript DataPlugin。候选可选择、过滤和
排序已有 record ID，但不能替换 Controller、DSH agent loop、Evaluator 或
AcceptancePolicy。capability 只记录候选意图和实验元数据，不是安全权限。

一个 TaskProfile 同时只有一个 active 候选和一个 open 候选，跨代保留不可
覆盖的候选历史。候选必须先在普通 Node 子进程中通过固定 fixture，再等待
外部 B_dev 报告；只有严格胜过当前 active 的候选才由 Controller 通过 DSH
Dynamic Runner 正式加载。

TaskProfile 由 Host 配置，模型不能创建或修改。首次启动且 Store 为空时，省略
配置会创建内置 `default` Profile（`autodata-fixture`、指标 `score`、三项数据
能力）；它只用于安装和基础闭环验证，没有真实 B_dev 时候选保持
`validated/open`。正式 benchmark 通过 `autodata-service.config.profiles` 声明
一个或多个不可变 Profile；显式列表不额外混入 `default`，相同配置重启复用
已有历史，规则改变则必须创建新 ID。已有 Store 且省略配置时直接恢复其中的
Profile，不创建第二套默认状态。

## Public Contract

`ctx.autodata` 只公开候选需要的数据面，不公开 Controller 或 Store。可信 Host
代码通过包导出的 `getEvolutionController(ctx)` 取得控制面：

```ts
const evolution = getEvolutionController(ctx)
evolution.createProfile(profile)
evolution.submitCandidate(profileId, candidate)
evolution.validateCandidate(profileId, candidateId)
evolution.recordFeedback(feedback)
evolution.feedback(profileId, feedbackId?)
evolution.recordEvaluation(report, agent)
evolution.status(profileId)
evolution.rollback(profileId, candidateId, agent)
evolution.resume(profileId, agent)
```

Controller 由模块私有 `WeakMap` 绑定到 `AutoDataService`。AutoData 自己的工具
使用同一个内部 accessor；Dynamic Runner 中的候选即使注入 `autodata`，也只能
调用 `register`、`run`、`plugins` 等数据能力，不能绕过工具直接写演化状态。

正式提交直接携带 `candidate_id`、`strategy_version`、`host_source`，以及可选的
`description`、`capabilities` 和 `metadata`。不保存临时 DSH Plugin/Package ID，
也不提供 `submitDraftCandidate`、`inspectDraft` 或 `stopDraft`。

Agent 可见工具为：

- `autodata_evolution_status`：读取 TaskProfile 和候选状态；
- `autodata_evolution_feedback`：读取当前或指定的 B_search 反馈；
- `autodata_submit_candidate`：直接提交源码并立即运行子进程验证。

反馈由 Host 写入、Agent 只读。每条反馈绑定写入时的 active 候选，只允许
`B_search`，包含摘要、至多 50 个失败样例、可选指标和整体评测 artifact 的
绝对路径。完整 artifact 仍由 DSH 已有文件或命令工具按当前 Profile 权限读取。
`B_dev` 只用于 Controller 接受，`B_test` 在最终冻结前不进入演化反馈。

状态机为：

```text
proposed -> validated -> accepted
                    \-> rejected
accepted 被替换 -> retired
```

验证失败、B_dev 持平/下降或报告不完整都会拒绝候选并清空 open。候选激活
明确失败且旧 active 已恢复时同样拒绝，并记录 `runtime_activation_failed`；
Runner 不可用或恢复降级属于基础设施异常，保留 validated/open 供重试。

## Persistence and Validator

默认根目录为 `AUTODATA_HOME`，未设置时为 `$DSH_HOME/autodata`。生产 Service
在两者均缺失时明确失败；Memory Store 只用于显式测试构造。

```text
profiles/<profile-id>/
  profile.json
  state.json
  candidates/<candidate-id>/
    manifest.json
    package-host.js
  feedback/<feedback-id>.json
  runs/<run-id>/
    summary.json
    decision.json
```

`state.json` 是 active/open、候选历史和反馈指针的唯一状态真源，使用临时文件
加 rename 原子替换。候选、反馈和评测记录不可覆盖。文件已写入但未被 state
引用的目录视为中断 artifact，加载时忽略，但相同 ID 仍不可复用。

Stage 3 不引入 `active.json`、锁、CAS、哈希链、protocol lock、运行时完整性
哈希门禁或第二套日志协议。

Validator 直接启动普通 Node 子进程，默认限制为 15 秒、1 MiB 聚合输出、
128 MiB Node old-space 和 256 KiB host source。独立 result FD 防止候选日志
污染结果。它验证 host-only、精确 `inject: ['autodata']`、恰好一个指定
ID/version 的 DataPlugin、固定 fixture 和停止清理。它不使用 bwrap、prlimit、
namespace、UID/GID、Node permissions 或网络/挂载隔离，也不宣称恶意代码沙箱。

## DSH Agent Flow and Gates

AutoData 通过 DSH system prompt 注册简短候选契约：`host_source` 是 async
function body，返回 Cordis Plugin 并注册一个 DataPlugin；Agent 先读取 status
和 feedback，再直接调用提交工具，不使用 `cordis_define` 或 `cordis_run`。

Gate 3A 必须证明 File Store、Node Validator 和真实 DSH Runtime 能完成
propose、validate、accept/reject、rollback、Service unload/reload 和 restart
resume，失败候选不影响旧 active。

Gate 3B 的普通 CI 使用确定性 fake model 驱动真实 DSH Agent/Session/Tool loop。
本地真实 smoke 使用 DSH 原生模型路由调用 FreeRouter 的 `gpt-5.6-sol`，从
synthetic B_search 失败反馈生成并提交至少一个通过 Validator 的候选。凭据只从
进程环境读取。实现入口为 `FREEROUTER_API_KEY=... pnpm smoke:freerouter`，固定
provider route 为 `free-router`、API 为 `openai-responses`、base URL 为
`https://free-router.opendatalab.com/v1`，provider 和 model 的推理档位固定为
`high`。脚本不加载 credentials/auth 文件；缺少
环境变量时在模型适配器和 Agent stack 装载前跳过，普通 `pnpm check` 也不会调用
真实 API。Agent turn 限时 120 秒，整个 smoke 进程限时 180 秒；成功只在 Agent、
Cordis Context 和临时目录均完成清理后报告。`FREEROUTER_API_KEY` 不传入候选
Validator 子进程。smoke 组合 DSH 标准 `dsh-llm-retry` 执行器，使用 provider
默认的有限策略处理瞬时 `TIMEOUT`、`RATE_LIMIT`、`SERVER`、`TRANSPORT` 和
`EMPTY_RESPONSE`；若环境提供标准 `HTTP_PROXY`、`HTTPS_PROXY` 或小写等价
变量，Node 请求通过 `EnvHttpProxyAgent` 遵循这些代理及 `NO_PROXY`，不会把
代理地址或凭据写入结果。失败输出仅包含经白名单和脱敏处理的稳定错误码与消息；
成功 JSON 记录已验证的工具调用顺序、候选状态与版本、实际启动的重试次数，以及
所有 provider attempt 已报告的汇总 token usage。离线测试只证明配置可被 DSH
接受和无凭据路径不会联网；真实模型未通过时不得宣称 Gate 3B 完成。

Stage 3A 与 Stage 3B 分别形成可回滚提交，二者都通过后才宣布 Gate 3 完成。
Stage 4 才通过 DSH `ctx.jobs` 接入 Python Trainer/Evaluator 和真实训练/GPU。
