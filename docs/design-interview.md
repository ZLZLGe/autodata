# AutoData 设计访谈与决策台账

## 跨会话接管入口

更新时间：`2026-09-06 02:22 HKT`（`2026-09-05 18:22 UTC`）。本节是新 Codex 的接管起点；即使旧 session、加密上下文或会话摘要无法恢复，也应能仅凭仓库中的本台账继续工作。

### 当前目标与阶段

- 最终目标是彻底重构 AutoData，并用真实组件跑通 `H₀/baseline checkpoint → Diagnosis Agent → Generator Agent → candidate harness → 小模型训练 → SWE-bench Full dev → 晋升或归档` 的闭环；不是只完成接口、mock 或文档。
- 当前仍处于**设计收口**，尚未开始这次业务重构。先回答文末 Q38，并继续关闭“当前 frontier”；在这些阻塞设计点获得用户明确确认前，不得把助手推荐当成默认决定，也不得提前改业务代码。
- 用户已经确认“第一版先完整打通一个新 candidate”这一目标，但尚未确认 `max_rounds` 的默认值以及 round 从何时开始计数。任何把 `max_rounds=1` 写成既定合同的说法都不成立，精确问题见本节末尾和文末 Q38。
- 当前仓库实现仍是旧的 BFCL/GetElucid Stage 4C 路线，只能作为迁移输入或历史参考，**不代表本轮已经确认的目标架构和实验合同**。根目录 `README.md` 也属于 legacy 说明，不应据其覆盖本台账。

### 权威资料与接手顺序

1. 先读根目录 `AGENTS.md`，确认活动仓库、开发约束以及代码与运行产物的边界；飞书职责以本台账和项目级接管说明为准，不要求在 `AGENTS.md` 再复制入口。
2. 再读 `CONTEXT.md`，只把它用作领域词汇表；它不是实现 spec。
3. 读 `docs/adr/0001-*` 至 `0003-*`，了解三项难以逆转的决定及替代关系：Verified 提案已被 Full 取代，活动实现要去除 BFCL 专属耦合。
4. 在本文先读“当前设计摘要（汇总至 R28）”，再读“R19–R28/Q38 决定索引”和“当前 frontier”；需要核查某个决定为何成立时，再回到对应 Q/R 条目。编号更晚的明确用户回答优先，`继续`、`没看懂`、追问或要求解释都不是确认。
5. 飞书项目页保存研究决策和实验台账；`/data` 或 GPFS 保存数据、模型、日志、checkpoint 和其他运行产物。不要把这些内容重复提交到 Git。原始 session 只用于审计来源，不是理解本设计的必需前提。

本仓库不再新增 HANDOFF/spec/runbook 来复制同一事实；跨会话接管信息以本节、当前摘要、决定索引和 frontier 为准。

### 当前 Git 与验证状态

- 本次文档 checkpoint 整理前，`main == origin/main == 9c872d6d7a439a5e856d679e2c9f193cb5eaedec`；最终接管 checkpoint 以包含本文的已推送 `main` HEAD 为准，并由飞书接管记录保存对应 SHA。
- `pnpm typecheck` 已通过。
- `pnpm check` 第一次在测试加载前因 `/tmp` 的 7 GiB tmpfs 已满而报 `ENOSPC`，当时执行了 `0 tests`；这不是业务断言失败。随后使用 `/data/codex-work/autodata/tmp` 作为独立 `TMPDIR` 重跑，完整检查已通过（28 个 Vitest 文件、310 个测试、两组 Python 测试、Profile smoke 与 npm pack dry-run）。没有删除用户现有 `/tmp` 内容。

### 接手后精确下一步：Q38（尚未回答）

> **Q38 — 首版运行几轮**：一次 evolution round 指：
>
> `Diagnosis → Generator → 新 candidate → 训练 → 评测 → 晋升判断`
>
> baseline/H₀ 的准备与评测不计入 round。
>
> 是否确认 `max_rounds` 默认设为 `1`，即首版先完整跑通一个新 candidate？Host 一旦开始该轮 Diagnosis 就算消耗这一轮；candidate 无效或未晋升也算，基础设施原样重试不增加轮数。

推荐原文：

> 推荐确认。以后只需调大 `max_rounds`，无需修改流程。

用户尚未回答 Q38。下一位 Codex 应先解释或重问这一题，不得依据“先打通一个 candidate”的目标自行记为 `accepted`。

状态：`进行中`。这份文档是 `/grill-with-docs` 设计访谈的可追溯记录，不是实现 spec，也不是把所有内容提前冻结的架构合同。实现前仍需要把文末“当前 frontier”中标为 `open` 或 `needs-confirmation` 的阻塞节点问完，并由用户确认共同理解；历史正文中后来已被关闭或取代的旧状态不构成当前阻塞。

AutoData 是当前活跃产品和仓库，工作目录是 `/root/autodata`：它是一个可安装到 DeepSeek Harness（DSH）的插件，以及插件负责的数据处理和自进化能力。`DataHarness` 只在引用历史项目名称或 DSH profile 语境时使用，不是当前实现目标，也不指向另一个待修改仓库。

文中随各轮记录出现的“当前状态”“当前前沿”只表示该轮结束时的历史快照。判断今天的设计状态时，以“当前设计摘要（汇总至 R28）”、文末“R19–R28/Q38 决定索引”和“当前 frontier”合并阅读；发生冲突时，以编号更晚的明确用户回答为准。

## 访谈范围

本台账从用户在当前根会话中提出“先帮我安装这套 `grill-with-docs` skill”开始（`history.jsonl:3131`，当前 session ordinal `3131`）。此前关于 ARIS、旧 DataHarness、阶段 1–4A 以及早期研究方向的会话不属于本次访谈正文；它们只作为代码或项目背景被动存在，不在这里重新整理成问答。后续记录从 skill 的使用方式、AutoData 背景说明和 Q1 开始。用户随后明确范围仍以该起点为准（当前 session ordinal `5690`；`history.jsonl:3272-3273`），因此此前任何把 3131 之前内容纳入正文的做法均不适用。

## 记录规则

### 状态词

- `accepted`：用户明确同意或选择；若同时带 `provisional`，表示只对当前第一版有效，未成为长期实验协议。
- `clarified`：用户修正了原问题的前提，修正后的内容保留，原建议标为被替代。
- `open`：用户没有回答、明确要求继续讨论，或仍缺少可逆/不可逆边界。
- `needs-confirmation`：已有合理建议或部分同意，但不能从原话推出完整决定。
- `superseded`：后续回答已经替代了早期结论；早期记录保留以便追踪决策如何变化。
- `informational`：问答主要是在解释事实或概念，没有形成需要用户拍板的决定。

### 原文和归纳的边界

1. `用户原答`尽量逐字保留，包含原有措辞、疑问和临时表述；只有为避免泄露凭据或大段原始轨迹时才省略，并明确说明。
2. `助手问题/建议`保留问题选项和建议的实质内容；完整助手消息仍可由来源定位读取，不把模型内部 reasoning、系统提示词或无关工具输出复制到项目。
3. `当前归纳`是对原答的工程化解释，不等同于用户已经批准的规范。
4. 新增记录必须同时给出 session ID、assistant/user 的 event `ordinal`、对应 JSONL 物理行号和 UTC 时间戳，并直接保存决定性问题与推荐原文。event `ordinal` 从 `0` 开始，因此 `JSONL line = ordinal + 1`；它不是消息编号或 Git 行号。只写“续接会话中的 Qxx”不构成可独立复核的来源。
5. 重复的“继续”、测试消息、凭据探测和与 AutoData 设计无关的运维操作不逐条复制；原始 transcript 仍是完整证据。

## 证据目录

| 证据 | 用途 | 捕获信息 |
|-|-|-|
| `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`（追加捕获） | 本轮用户回答的可复核前缀 | ordinal `6609`（6,610 行、prefix byte end-offset `62,161,659`，exclusive；末行 timestamp `2026-09-03T09:32:33.258Z`），前缀 SHA-256 `5b2c5b61303eec510f34810adb35bd4c304ce438f990751651330fa05a128716` |
| `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl` | 当前设计会话的根线程原始事件 | session `01a060d5-6a05-7573-9259-8e535905a19f`；initial 捕获点 A 为 ordinal `4841`（4,842 行、prefix byte end-offset `45,540,482`，exclusive；末行 timestamp `2026-09-03T07:29:34.890Z`），前缀 SHA-256 `c62fa69de7d8477f98499dc6c5daf8dd69ed759647b9b50b4fe13eb2703142e2`；review 捕获点 B 为 ordinal `5047`（5,048 行、prefix byte end-offset `49,049,850`，exclusive；末行 timestamp `2026-09-03T07:42:22.563Z`），前缀 SHA-256 `24c56c1466731863199f1e901d3fed3b7bc3ff40f424c54ca1442093bcc973b1`；范围澄清捕获点 C 为 ordinal `5690`（5,691 行、prefix byte end-offset `58,662,417`，exclusive；末行 timestamp `2026-09-03T08:13:16.538Z`），前缀 SHA-256 `6c635d975fd03ce4f3189c96a04c9aa13b721bcc7b2408bfbb649b47a8f6cb99`；本轮回答捕获点 D 为 ordinal `6016`（6,017 行、prefix byte end-offset `60,450,000`，exclusive；末行 timestamp `2026-09-03T08:45:53.586Z`），前缀 SHA-256 `ed97bed5d860e34545053277abd07b52eb4af264989976fcd03b7c3159f5431a`；本轮回答捕获点 E 为 ordinal `6206`（6,207 行、prefix byte end-offset `60,858,016`，exclusive；末行 timestamp `2026-09-03T09:05:55.469Z`），前缀 SHA-256 `7f2755184f166f1393c30085ec3c63d43893dccdfe86519f74076dfb79954c8a`。|
| `/root/.codex/sessions/2026/09/02/` 与 `/root/.codex/sessions/2026/09/03/` 中 `payload.session_id=01a060d5-6a05-7573-9259-8e535905a19f` 的 continuation 文件 | 同一根线程在上下文压缩/续接时产生的事件快照 | 与根线程有重复；不能用单个 continuation 文件代替根线程。读取时以 `ordinal`、时间戳和 `session_id` 去重 |
| `/root/.codex/history.jsonl` | 用户消息索引和跨会话时间线 | 历史捕获点为 3,178 行、prefix byte end-offset `441,749`（exclusive；末条记录 `ts=1788420545`，UTC `2026-09-03T07:29:05Z`），前缀 SHA-256 `3851b8772b6ae64b3f5c793982fb61b07baee8d039d8bef070bd3e65d90e6331`；范围澄清捕获点为 3,273 行、prefix byte end-offset `451,447`（exclusive；末条记录 `ts=1788423190`，UTC `2026-09-03T08:13:10Z`），前缀 SHA-256 `1a531d6ac6f8b48fd401b1c3bbfbe266889b7b88ba067d4c3cad169f6f35cbd9`；上轮回答捕获点为 3,275 行、prefix byte end-offset `452,160`（exclusive；末条记录 `ts=1788425153`，UTC `2026-09-03T08:45:53Z`），前缀 SHA-256 `0abde6a50d04608b958939da06c732d8394726602cee83fe92780a782363ef33`；本轮回答捕获点为 3,276 行、prefix byte end-offset `452,998`（exclusive；末条记录 `ts=1788426353`，UTC `2026-09-03T09:05:53Z`），前缀 SHA-256 `e633005866e1d57527ce7776ce47948cd41f13379f1d05be505a17ed78de1a9c`；文件后来继续增长 |
| `/root/.codex/history.jsonl`（追加捕获） | 本轮用户回答的可复核前缀 | 捕获点为 3,277 行、prefix byte end-offset `453,371`（exclusive；末条记录 `ts=1788427953`，UTC `2026-09-03T09:32:33Z`），前缀 SHA-256 `076f2adccccebb591b862a6fa2fd4c24fb65eb4880f14c214e3795b6992d4164` |
| `/root/.codex/history.jsonl`（追加捕获） | Q27b-1b/Q20-1b 用户回答的可复核前缀 | 捕获点为 3,279 行、prefix byte end-offset `453,710`（exclusive；末条记录 `ts=1788431497`，UTC `2026-09-03T10:31:37Z`），前缀 SHA-256 `40228b73e79be98cfa3b01087f5614ec1d5c352c25b05589a3f6b981efa32d43` |
| `/root/.codex/history.jsonl`（追加捕获） | Q20-1c/Q27b-1c/Q27a/Q28a/Q29a 用户回答的可复核前缀 | 捕获点为 3,280 行、prefix byte end-offset `454,127`（exclusive；末条记录 `ts=1788432984`，UTC `2026-09-03T10:56:24Z`），前缀 SHA-256 `c740a0a14445050eaf5fc51ee6e5573801be974d7e449da8a808607ce2c28e11` |
| `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T23-01-58-01a067ca-7ae5-7de3-967c-13a7abb46b76.jsonl` | R16–R17 的逐消息证据 | session `01a067ca-7ae5-7de3-967c-13a7abb46b76`；R16/R17 同时列出 event ordinal、JSONL 物理行号和 UTC |
| `/root/.codex/sessions/2026/09/04/rollout-2026-09-04T09-49-38-01a06a1b-7043-7703-8eba-1ab422940c59.jsonl` | R18/Q28a-11 的逐消息证据 | session `01a06a1b-7043-7703-8eba-1ab422940c59`；记录用户纠正“继续不是确认”、最终训练协议与空视图决定 |
| `/root/.codex/sessions/2026/09/05/rollout-2026-09-05T23-10-44-01a0721f-39cf-72b3-b029-c8c8a9c5ff47.jsonl` | R19–R28 与尚未回答的 Q38 的逐消息证据 | session `01a0721f-39cf-72b3-b029-c8c8a9c5ff47`；各记录同时列出从 `0` 开始的 event ordinal、从 `1` 开始的 JSONL 物理行号和 UTC 时间戳 |
| 根 session ordinal `7548`；`history.jsonl:3282` | Q28a-1 的直接用户回答 | 用户选择 A：首版在 Core 中实现配比原语；其中 repeat 部分随后被 Q28a-2/R13 明确取消，其他原语选择仍有效 |
| 根 session ordinal `7805`；`history.jsonl:3305` | 根 session 的历史捕获点 | Q28a-7 接受 `TrainingViewEntry`；Q28a-4 确认不刻意补足并追问 weight；Q28a-5 要求先解释 quota；后续决定见其他 session 的 R16–R28 |
| `/root/autodata/CONTEXT.md` | 稳定领域词汇 | 当前只应承载 glossary，不承载逐题问答或实现细节 |
| `/root/autodata/docs/adr/0001-use-swebench-verified-as-initial-benchmark.md` | 历史 benchmark 提案 | 状态为 `superseded by ADR-0002`；Verified 从未成为本轮已接受的首个 benchmark |
| `/root/autodata/docs/adr/0002-use-swebench-full-as-first-benchmark.md` | 当前 benchmark 决策 | 状态为 `accepted`；记录 Full dev search、Full test sealed、首版无独立 promotion validation 和可替换 TaskRunner |
| `/root/autodata/docs/adr/0003-remove-bfcl-from-active-implementation.md` | 当前活动代码边界 | 状态为 `accepted`；删除 BFCL 专属活动实现但保留历史证据和运行产物 |
| `/root/autodata/docs/stage3-evolution.md` | 历史 Stage 3 工程方案 | 其中的单插件 `host_source` 方案不是当前完整候选模型 |
| `https://aicarrier.feishu.cn/wiki/INz9wTtAAiPrpzkXqfUc2s96nIh` | 项目研究台账 | 本次本地 checkpoint 开始时读取的 revision `304` 新增“2026-09-04：AutoData 新设计访谈状态（替代后续执行路线）”；revision `303` 的旧实验事实继续保留，但 9 月 3 日访谈决定替代其未来执行顺序；本次 checkpoint 的 commit SHA 记录在随后追加的飞书接管条目 |

原始会话可能随当前会话继续增长；上面的哈希和行数都是带明确 ordinal/byte offset 的历史捕获点，不应被理解为对未来追加事件或当前整文件的哈希承诺。

## 跨来源对照

本次回顾最初读取了飞书 wiki revision `303`。该 revision 的章节标题显示为 2026-08-31 的项目工作版本；它同时包含相对稳定的方法层（固定 DSH/Cordis、闭集数据策展、`B_search/B_dev/B_test` 反馈边界）和仍标为工作方案的实验取值（例如 agent-sft/tool_calling、custom fixed BFCL、tau2 扩展）。revision `304` 后续新增“2026-09-04：AutoData 新设计访谈状态（替代后续执行路线）”：旧实验事实仍作为历史证据保留，但 9 月 3 日的新设计决定替代后续执行顺序。不能把这些不同层级都当作同一种“最终决定”。

本地设计会话随后先在 Q20 重新打开 benchmark 选择，最终又在 Q20-1 选择 SWE-bench Full 作为首个 profile；Q15/Q27b 则逐步确认了候选代码的物化原则，具体 workspace adapter 仍待落实。Q5 讨论的是活动仓库中 BFCL 专属代码的清理范围，不自动等同于删除飞书台账里的历史实验方案。因此本台账采用以下优先级：

1. 用户在本地 session 中对具体问题的后续原答，是该问题的主要证据；
2. 飞书内容作为项目背景和已记录的并行方案，不被静默覆盖，也不被自动当作本地问答的确认；
3. 两者冲突时，保留两边的来源、时间和状态，直到用户明确裁决；
4. 本台账不把飞书已有的实验记录、运行摘要或 artifact 重新复制进 Git。

这意味着“BFCL/tau2 工作方案”与“Q20 曾重新开放 benchmark 选择、随后 Q20-1 选择 Full”可以同时出现在记录中，但它们不是同一层级的结论：前者是 revision `303` 保留的历史工作方案，后者是本地访谈中更晚的决策演变，并已由 revision `304` 记录为后续执行路线；“Q5 清理 BFCL 专属活动代码”则是另一个已明确的代码范围决定。

### 主题级状态矩阵

| 主题 | 飞书 revision `303` 保留的历史记录 | 本地访谈 / revision `304` 的当前状态 |
|-|-|-|
| 固定运行时和实验骨架 | 固定 DSH/Cordis、Controller、闭集策展；`B_search` 驱动生成，`B_dev` 做接受/回滚，`B_test` 密封；候选从同一基础模型和冻结配方比较。 | 与 Q1/Q11/Q16/Q21/Q25b 的方向基本兼容；具体 adapter、停止条件和实现合同仍需确认。 |
| 激活与晋升 | 记录了 Controller 自动接受/回滚和单 active 版本的具体工作方案。 | Q10/Q25b 已确认自动晋升形状与 champion + immutable archive；R23 以完整 manifest 的 `resolved_count` 为主指标，R25 要求严格增加才晋升，R26 在 v1 不设逐 case veto；R24 将随机稳定性验证延期。 |
| 候选可修改范围与物化 | 记录了较窄的 host-only 单插件/源码快照路线。 | Q27b 已确认隔离 workspace → 完整 snapshot → 派生 diff，以及第一版修改白名单；具体 DSH workspace adapter 和沙箱资源限制仍待落实。 |
| Benchmark profile | 记录 custom fixed BFCL 及 tau2 的工作方案。 | Q20-1 已选择 SWE-bench Full；首版使用 Full dev 做反复 search、Full test 密封，不设独立 promotion validation。Q5 的 BFCL 活动代码清理与此实验取值分属不同层次。 |

因此，飞书记录可以作为方法背景和历史实现证据，但不能替本地访谈关闭尚未回答的问题；反过来，本地对 Q10/Q20 的后续确认，以及 Q15/Q27b 尚余的实现细节，也不应被误写成已推翻飞书中所有方法层决定。

## Skill 启动与访谈前提

### 选择 `/grill-with-docs` 沟通

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；user event ordinal `3206`（JSONL line `3207`，`2026-09-03T03:53:40.157Z`）作出选择；assistant event ordinal `3226`（JSONL line `3227`，`2026-09-03T03:55:14.191Z`）确认按该方式开始访谈。

用户先问能否只用两个 skill，随后明确：

> 那我打算就用/grill-with-docs了

当前归纳：本项目采用同一会话中的 `/grill-with-docs` 访谈；不把 `/to-spec`、`/to-tickets`、多会话 ticket 当作前置硬门槛。访谈结束并得到共同确认后，可以在同一会话开始实现。

状态：`accepted`（工作方式）。这不改变“设计未确认前不实现”的访谈纪律。

### 研究目标的当前版本

来源：同一根 session 和文件；user event ordinals `3272`（JSONL line `3273`，`2026-09-03T04:04:56.204Z`）、`3279`（line `3280`，`2026-09-03T05:08:44.068Z`）和 `3286`（line `3287`，`2026-09-03T05:13:01.750Z`）依次补充并修正背景；用户消息索引为 `history.jsonl:3149-3151`。

用户背景的稳定要点：

- 整体重构 AutoData，使其高内聚、低耦合、可扩展；
- 从活动仓库删除 BFCL 配置和专属实现，使仓库干净；
- 输入是标准 ms-swift JSONL，先按标准格式读取，忽略无关顶层字段；
- 输入批次经数据清洗和数据配比后训练小模型；
- 小模型在下游 benchmark 上评测；
- 强模型通过 DSH 分析成功/失败轨迹，输出诊断；
- Generator 根据诊断修改整体数据清洗和数据配比策略；
- 第一版先完整打通一个新 candidate；`max_rounds` 是可配置超参数，但默认值和 round 计数语义仍待 Q38 确认；
- 将来可能增加轨迹质量评估等 role/stage。

状态：`accepted`（目标层）；具体 benchmark、候选产物、训练调度和角色协议由下面的访谈决定。

## 第一轮：根边界（Q1–Q6）

### Q1 — 第一阶段的完成定义

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`；同一用户消息索引为 `history.jsonl:3155`）。

决定性问题原文摘录：

> 第一阶段是否要求真实执行小模型训练、SWE-bench Verified 评测、两个 DSH 角色，并真实产出下一代策略？

推荐原文摘录：

> 真实跑通主流程；训练、benchmark、DSH 都通过可替换接口接入，同时为每个接口保留 fake 实现用于测试。

用户原答：

> Q1：同意你说的

当前归纳：目标是可运行的真实纵向闭环，不是只做 mock；接口必须可替换，测试可以使用 fake runtime/adapter。

状态：`accepted`（真实纵向闭环和可替换接口范围）；Verified 作为唯一 benchmark 的部分后来由 Q20 重新打开，并由 Q20-1 选择 SWE-bench Full 而 `superseded`。

### Q2 — `generations=1` 的含义（第一次表述）

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`）。

决定性问题/选项原文摘录：

> **Q2 — `generations=1` 的含义**：`1` 是指：
>
> A（当时推荐）：运行 generation 0，做一次诊断和策略更新，持久化 generation 1 后停止；
> B：generation 0 和 generation 1 都完整训练、评测后停止；
> C：总共只运行一代，不做策略更新。

推荐原文摘录：

> 推荐 A：和你描述的“产出一代新的 DSH”一致，也能先把闭环边界跑通。

用户原答：

> Q2：同意你说的

当前归纳：用户同意了当时的 A，但后续 Q11 明确选择 B，说明候选 generation 1 也要训练和评测。因此本条的早期语义不再是当前语义。

状态：`superseded`（被 Q11 澄清）。

### Q3 — 下一代的产物

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`）。

决定性问题/选项原文摘录：

> 另一个 DSH 修改后，最终要产出什么？
>
> A. 一个版本化的策略包，包含清洗策略、数据配比、参数、诊断依据和父代信息
> B. 直接生成并修改 AutoData 的 TypeScript 源码
> C. 生成一个新的 DSH Profile / Bundle 配置

推荐原文摘录：

> 推荐 A：DSH 负责提出策略，AutoData 负责校验和执行，避免模型直接改仓库代码。

用户原答：

> Q3：这个要讨论一下，本身我们autodata就是一插件，这个插件也能集成到dsh里面去，相当于变成dataharness，我不确定是要改插件还是怎么弄，不过dsh是支持改插件的吧，这个得仔细讨论一下

当前归纳：AutoData 自身是可安装到 DSH 的插件；本轮不能用声明式策略包直接替用户决定。Q8、Q15、Q23b 和 Q27b 后续把问题收窄并最终确认：Generator 在白名单隔离 workspace 中修改候选代码，Host 固化完整 `CandidateSnapshot` 作为执行真相，diff 是派生审计附件。

状态：本轮为 `open/clarified`；当前高层物化原则已由 Q27b、Q27b-1 与 Q27b-1b `accepted`，本条早期“只生成声明式策略包”建议 `superseded`。具体 DSH workspace/tool adapter 与持久化协议仍 `needs-confirmation`。

### Q4 — 主轨迹、嵌套 sub-agent 和 `developer`

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`）。

决定性契约/推荐原文摘录：

> 目录中读取真正的 `.jsonl` 文件，每行一个顶层轨迹对象；只投影 `messages` 和 `tools`，其他顶层字段忽略；如果出现 `sub_agent_trajectory` 或 `completeness.is_subagent=true`，将该记录拒绝或隔离，不进入训练；`developer` role 因不在标准 role 集合中，也拒绝或隔离；样例里的多行 `.json` 文件只作为参考/异常 fixture，不作为正式训练输入。
>
> 推荐采用这套严格规则。请确认是否同意，尤其是 `developer` role：是严格隔离，还是需要映射为 `system`？

用户原答：

> Q4：如果一条轨迹里面有主轨迹和subagent轨迹，这个只读主agent轨迹就行了，不用排除掉整个轨迹，developer的情况暂时也要保留，后续我去确认一下要不要改，不过就算代码已经实现了，developer这个问题要改的话也很简单对吧

当前归纳：用户明确要求有嵌套 sub-agent 时保留并只读取顶层主轨迹，不因嵌套信息丢弃整条记录；`developer` 暂时原样保留，后续再确认是否转换。顶层 sub-agent-only 记录如何处理、canonical/trainer 投影和 quarantine 规则，是实现建议，不能从这条回答直接推导为已确认合同。

状态：`clarified`（主轨迹与 `developer` 的修正）；顶层 sub-agent-only 处理和字段投影仍 `needs-confirmation`。助手“整条拒绝”和“拒绝 developer”建议被替代。

### Q5 — BFCL 清理范围

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`）。

决定性问题原文摘录：

> 是否彻底删除仓库中所有 BFCL 专属的配置、profile 示例、stage4a/stage4b 资源和 worker、BFCL 专属类型/字段/脚本、BFCL 测试和文档，只保留与 benchmark 无关的通用执行、状态和存储能力；历史 `/data` 产物不改动？

推荐原文摘录：

> 推荐彻底移除活动仓库中的 BFCL 专属内容，不保留旧 BFCL 兼容入口。

用户原答：

> Q5：可以，按你推荐的来

当前归纳：活动仓库不保留 BFCL 兼容入口；历史数据、日志和研究台账属于外部运行产物，不因代码清理而删除。

状态：`accepted`。这是活动代码清理范围，不代表所有历史文档中的 BFCL 文字都自动变成当前方案；历史文档需要标明历史/被替代。

### Q6 — 逻辑角色与宿主边界

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3410`（JSONL line `3411`，`2026-09-03T05:18:26.452Z`）；user event ordinal `3416`（JSONL line `3417`，`2026-09-03T05:32:33.296Z`）。

决定性问题原文摘录：

> 是否按两个独立角色设计：Diagnosis DSH 读取 benchmark 结果、成功/失败轨迹和数据集统计，输出结构化诊断；Strategy DSH 读取诊断和当前策略，输出下一代策略包；两者都不直接修改 AutoData 源码或运行状态，由宿主进行校验、持久化和应用？

推荐原文摘录：

> 推荐这样设计，以后增加“轨迹质量评估 agent”等角色时只需注册新角色，不改主流程。

用户原答：

> Q6: 是的，需要按两个角色来设计，但是我不知道是直接调sdk然后写个prompt就行还是怎么做，最新的别人论文里面设计agent是怎么做的，我看论文里面也是有很多agent角色，这个是调sdk么，至于要不要修改源码或运行状态，由宿主进行校验、持久化和应用，这个问题还是得具体讨论一下，然后你说的增加“轨迹质量评估 agent”等角色时只需注册新角色，这个感觉还蛮有意思的，我们讨论的时候也可以把这个纳入进来大致讨论一下

当前归纳：保留两个逻辑职责，但第二个角色的规范名称改为 `Generator Agent`，不再设独立 `Strategy Agent`；角色运行时、SDK 边界、未来 role/stage 注册机制另行讨论。

状态：`clarified`；“Strategy DSH”术语被 Q8/Q14 撤销，改为 Generator Agent。Host 作为受信任控制面的高层边界后来由 Q23b–Q26b/Q27b `accepted`；具体 child runtime/API 仍 `needs-confirmation`。

## 第二轮：插件、角色和反馈（Q7–Q14）

### Q7 — AutoData 与 DSH 的插件边界

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant question event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。assistant 后续解释位于 event ordinal `3740`（JSONL line `3741`，`2026-09-03T06:04:06.616Z`）和 `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）仍表示没有理解该分层，因此这些解释不构成对内部三层结构的新确认。

决定性问题原文摘录：

> 你希望 AutoData 作为一个 DSH Bundle 集成，但内部是否拆成“纯领域/应用核心 + DSH 适配层”？

推荐原文摘录：

> 同一个仓库内分层，初期仍发布一个 `@zlzlge/autodata` Bundle。核心只依赖端口（输入连接器、训练器、benchmark、角色运行时、artifact store），DSH 适配层负责把这些端口接到 `ctx.agents`、`ctx.systemPrompt`、`ctx.jobs` 等服务；不 fork DSH，也不让模型改宿主 Profile/Bundle。

用户原答：

> Q7:我是想做成可以集成到dsh的插件，因为当前dsh很火，dsh也天然适合自进化，但是我没看懂你说的意思

当前归纳：用户明确的方向是把 AutoData 做成可集成到 DSH 的插件。内部拆成一个 Bundle 的 `core/adapters/dsh` 三层，是助手为此提出的解释性组织方案；用户当时表示“没看懂”，所以不能把每层的具体目录和依赖当成已经批准的结构：

```text
一个 AutoData Bundle
├── core：清洗、配比、候选、种群、选择等纯逻辑
├── adapters：ms-swift、训练器、benchmark、文件/作业后端
└── dsh：DSH Service、Agent、Session、Job 适配
```

状态：`accepted`（可集成到 DSH 的单插件方向）。`core/adapters/dsh` 只是当时未获确认的说明性结构；模块划分与公开 API 映射归入 implementation-spec pending，不把它伪装成用户决定，也不作为当前独立设计阻塞。

### Q8 — Diagnosis 与 Generator 的职责，以及是否允许改代码

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant question event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`；该回答纠正了原问题前提）。assistant 对修正的复述位于 event ordinals `3642`（JSONL line `3643`，`2026-09-03T06:00:20.914Z`）、`3668`（JSONL line `3669`，`2026-09-03T06:00:55.478Z`）和 `3740`（JSONL line `3741`，`2026-09-03T06:04:06.616Z`）；它们不是新增用户确认。

决定性问题/选项原文摘录：

> **Strategy DSH 生成的结果，是哪一种东西？**
> A. 版本化的声明式 `DataStrategy` 文档
> B. 对当前策略做 JSON Patch
> C. 可执行 JavaScript/DataPlugin/DSH 插件源码

推荐原文摘录：

> 推荐 A：生成完整、不可变的策略文档，由 Host 根据已注册的算子物化执行；以后确实需要新算法时，再由开发者注册新算子。DSH 的 Profile/Bundle 修改属于部署变更，不应成为模型每一代任意写源码的副作用。

用户原答：

> Q8:你好像理解错我的意思了，诊断agent就是看一下模型评测后的结果，包括成功失败的轨迹和结合，然后输出一个诊断，再由generator agent根据这个诊断来修改数据清洗数据配比策略，使得可以产出一批新的轨迹，这里面没有策略agent，感觉策略和诊断agent有点重复了？然后关于要不要改源码这个事情，要不你去看看最新的harness自进化怎么做的，别人是怎么维护种群的，是不是就是改他们代码，那我们是不是也要改代码，如果让开发者自己去设计算子，是不是不够？不够用来面对一些没想到的场景？

当前归纳：

- `Diagnosis Agent` 分析 benchmark 结果、成功/失败轨迹和相关证据，输出诊断；
- `Generator Agent` 根据诊断和历史生成候选 harness/数据策略；
- 不设单独的 Strategy Agent；
- Generator 可以提出新代码/组件，而不是只能调开发者预设的算子；
- DSH runtime、evaluator、训练安全边界、权限和持久化控制面被助手建议作为固定边界；是否逐项纳入候选合同仍需在 Q15/Q27b 中确认。

状态：`clarified`（角色和可演化对象已修正）；候选表示与修改边界后续已由 Q23b/Q24b/Q27b 及其子问题收口到隔离 workspace、完整 snapshot 和派生 diff，具体 adapter 仍 `needs-confirmation`。

### Q9 — 两个角色怎样运行

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。

决定性问题/选项原文摘录：

> **Q9 — 两个角色怎样运行**：论文里的“多个 agent”在工程上通常是多个逻辑角色，不一定是多个模型。你希望 AutoData 如何调用它们？
>
> A. Host 顺序创建两个独立的 DSH Agent/Session
> B. 一个 Session 里用不同 prompt 连续做两个阶段
> C. AutoData 绕过 DSH，直接调用 LLM SDK

推荐原文摘录：

> 推荐 A：Diagnosis 和 Strategy 的上下文隔离、日志和失败重试边界都清晰；默认可以用同一个强模型，但 `role_id -> provider/model` 必须可配置。角色只拿只读工具，返回结构化结果；写状态、提交候选和应用策略都由 Host 完成。SDK 调用应只存在于 DSH adapter/fake runtime 内，核心不直接依赖某一家 SDK。

用户原答：

> Q9:感觉确实A好一点，但是这是不是相当于插件里面设置了agent role，如果再把这个插件又集成到dsh里面去，这是不是相当于多了一个子agent路由，这样子合理吗，感觉还行？

当前归纳：AutoData 插件注册/调用 role，DSH 负责已有 AgentLoop；出现两个 child session 不等于增加第二个路由器或第二个 DSH 安装。

状态：当轮为 `needs-confirmation`（用户倾向 A，但使用“好一点/感觉还行”而非最终确认）；Q18 后续 `accepted` 两个逻辑角色使用 DSH child-session 模式。具体 DSH API、权限、生命周期和未来 N>1 fan-out 仍待收口。

### Q10 — Host 的应用闸门

初始来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。决定性重问为 assistant event ordinal `6004`（JSONL line `6005`，`2026-09-03T08:39:04.847Z`），对应 user event ordinal `6016`（JSONL line `6017`，`2026-09-03T08:45:53.586Z`；同一用户消息索引为 `history.jsonl:3275`）。

初始选项/推荐原文摘录：

> A. 通过校验后自动激活
> B. 只持久化为 pending，人工确认后激活
> C. 让 Strategy Role 自己写入并激活
>
> 推荐 A（但有硬闸门）：Host 先检查 schema、父版本、允许的算子和参数范围、样本/资源预算，并在固定 fixture 或抽样上做确定性 replay；通过后原子地写入不可变 artifact 并切换 active。任何失败都保留当前策略、记录拒绝原因，不让角色直接写全局状态。

初始用户原答（未作选择）：

> Q10:这个暂时不回答，我在前面说了策略agent和诊断agent好像重复了

决定性重问后的用户原答：

> Q10:选A，但是感觉dev里面还要划分一下训练集和验证集？防止一直在过拟合，最后的测试集用来作为最终的效果测试？

决定性重问/选项原文摘录：

> **Q10 — 候选何时成为 champion**：Host 校验和评测后，怎样决定是否替换当前 champion？
>
> A（推荐）. 只在候选通过确定性检查且 development split 指标严格优于当前 champion 时自动晋升；test split 只做报告，不参与晋升；无提升、平分或失败都保留旧 champion，并把候选和完整证据放入 archive。
> B. 每个候选都进入 `pending`，由人明确批准后才晋升。
> C. 候选完成评测就自动成为最新 champion。
> D. 第一版只评测和归档，不做晋升。
>
> 推荐 A，并明确“无提升保持旧 champion”。

当前归纳：用户确认自动晋升的总体形状：候选通过确定性检查并优于当前 champion 时才晋升，未提升时保留旧 champion。用户进一步要求把反复搜索与最终测试分开，以降低进化过程对 benchmark 的过拟合风险。

这里需要严格区分两种“训练/验证”：

1. **轨迹训练集/轨迹验证集**：输入轨迹池内部的划分，用于小模型训练和训练过程的早停或 loss 监控；它们不是 SWE-bench 任务实例。
2. **Benchmark search/dev/test**：SWE-bench 任务实例的评测划分。`search` 用于反复诊断和候选探索，`dev`/validation 用于晋升闸门，`test` 密封到最终效果报告，不能反复参与调参。

当时建议把用户所说的“dev 训练集”命名为 `search split`，避免误解为用 SWE-bench 任务训练小模型。后续 Q20-1/Q20-1b/Q20-1c 已把首版协议收敛为：SWE-bench Full 是首个 profile，Full dev 全量用于 search，Full test 密封；SFT 只生成 `trajectory_train`，不启用 `trajectory_valid`。因此本段早期关于三层 benchmark validation 和 Verified 内部分割的建议已被后续两层协议替代。

状态：`accepted`（自动晋升形状；无提升保留 champion；首版 Full 两层 benchmark 协议与单一 `trajectory_train` 已由后续回答关闭）。比较指标已由 R23、提升阈值和平分已由 R25、逐 case guardrail 已由 R26 关闭；仅最终 sealed test 的精确调用时机与报告协议仍 `needs-confirmation`。

### Q11 — 代数停止点和两个超参数

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。assistant event ordinal `3997`（JSONL line `3998`，`2026-09-03T06:32:06.376Z`）只是复述“generation 1 也要训练和评测”，不是新的用户确认。

决定性问题/选项原文摘录：

> **Q11 — `generation=1` 的停止点**：你说“暂时产出一代”，具体是下面哪一种？
>
> A. 运行 generation 0，生成并激活 generation 1 策略，然后停止
> B. 生成 generation 1 后，还要立刻用 generation 1 再训练和评测一次
> C. `generation` 指模型 checkpoint

推荐原文摘录：

> 推荐 A：第一阶段先证明闭环和持久化边界，避免一次实验成本翻倍；将来用 `max_generations` 控制是否继续完整循环。

用户原答：

> Q11:选B，然后我的意思是有两个超参数，一个控制一次性生成多少个候选harness，一个控制迭代多少轮

当前归纳：第一版候选生成后也要训练和评测；公开参数至少有：

- `candidates_per_round`：每轮生成多少个候选 harness；
- `max_rounds`：最多迭代多少轮。

状态：`accepted`（generation 1 也训练/评测；generation 0 基线训练/评测属于闭环；存在 `candidates_per_round` 与 `max_rounds` 两个参数）。失败分类与重试上限后来由 R27/R28 关闭；`max_rounds` 默认值及 round 计数语义仍由 Q38 保持 `open`。

### Q12 — JSONL 和坏行

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。

决定性问题/推荐原文摘录：

> **Q12 — 输入目录和坏记录策略**：标准文档的正式交付是 UTF-8 JSONL，但你给的样例是一个多行 JSON object。公开入口要怎样定？
>
> 生产入口严格接收目录中的 `.jsonl` shard，每行一个顶层轨迹 object；只投影 `messages` 和 `tools`，未知顶层字段忽略；有 `sub_agent_trajectory` 时保留主轨迹，训练投影不展开 nested sub-agent；顶层本身是 sub-agent 记录的行拒绝；`developer` 暂时原样保留到 canonical schema；单行 malformed 进入带原因的 quarantine，达到 `min_valid_records`/有效率门槛才允许继续，绝不静默跳过；样例这种单 object 文件只作为显式 fixture/转换输入，不自动和 JSONL 混用。
>
> 这里需要你确认的是：坏行是“隔离后继续”（推荐），还是“一行坏就整批失败”。

用户原答：

> Q12:实际上输入轨迹会是jsonl，可以看看/data/trajfoundry-batch-20260831里面的，都是jsonl，这里面的就是我自己把原始轨迹格式标准化以后的轨迹，然后如果出现jsonl里面有一行有问题，那就这一行不要了，继续用其他的

当前归纳：入口是标准 JSONL；用户明确单行坏记录丢弃后继续，不因一行错误使整批停止。行号、错误原因、quarantine 目录和有效率门槛是助手提出的审计实现建议，不能写成用户已经确认的要求；标准字段语义也仍需在实现契约中核对。

状态：`accepted`（坏行逐行跳过）；R19 后续将入口失败统一命名为 `Rejected input row` 并确认最小定位证据，R19/R22 以来源中立内容哈希替代 ID 回退链。quarantine 的物理目录和有效率门槛属于 implementation-spec pending；顶层 sub-agent-only 处理、精确字段投影以及 `developer` 的长期语义仍需用户确认，并已列入当前 frontier。

### Q13 — 首轮 benchmark 规模与评测反馈 artifact

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。assistant event ordinal `3963`（JSONL line `3964`，`2026-09-03T06:30:41.681Z`）讨论了相关概念，但不是本题决定性问答或新的用户确认。

决定性问题/推荐原文摘录：

> **SWE-bench Verified 的首轮规模**：Benchmark Adapter 是否同时支持 `instance_ids/limit`，让同一套协议既能跑小型闭环又能跑完整 500 实例？
>
> 推荐支持可配置子集；CI 用 fake fixture，第一次真实闭环先跑 1–5 个固定实例验证训练、Docker 评测、反馈和角色编排，再由正式 Profile 指向完整 Verified 500。Adapter 固定官方数据 revision、镜像和评测脚本 hash，输出统一的 per-instance 结果、测试摘要和成功/失败轨迹引用。

用户原答：

> Q13:同意你说的，但是成功和失败轨迹引用这个是什么意思，我是想的是要保留原始的评测出来的内容，以及简单用代码做的摘要，成功和失败轨迹也要保存下来

当前归纳：Benchmark Adapter 支持可配置子集/固定小规模 smoke run，再运行正式 profile；不能只保存指向轨迹的引用或 score，必须同时保存原始评测输出、代码生成的摘要、完整成功轨迹和完整失败轨迹。“引用”只表示 artifact 之间的索引关系，不表示丢弃正文。

状态：`accepted`（可配置规模和完整评测 artifact）；其中 Verified 500 作为正式 profile 的前提已由 Q20/Q20-1 改为 SWE-bench Full，故该 profile-specific 部分 `superseded`。完整 pinned profile 仍待补齐。

### Q14 — Diagnosis/Generator 可见反馈范围

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3609`（JSONL line `3610`，`2026-09-03T05:41:01.428Z`）；user event ordinal `3637`（JSONL line `3638`，`2026-09-03T06:00:12.439Z`）。

决定性问题/推荐原文摘录：

> **Q14 — 角色可见的反馈范围**：Diagnosis Role 和 Strategy Role 各自能看到什么？
>
> Diagnosis：聚合评测报告、每个实例的 pass/fail/测试摘要，以及受大小限制的成功/失败轨迹片段；需要更多内容时通过只读 artifact 工具按 ID 取。Strategy：默认只看 Diagnosis、当前 DataStrategy、约束和历史策略指标，不直接看 SWE-bench 的 oracle patch/test patch。两个角色都不能调用写状态、改 Profile、注册全局插件或直接提交执行作业的工具。

用户原答：

> Q14:诊断agent可以按你说的来，这样的话agent本身就可以去主动探索要看什么，但是成功轨迹失败片段这个东西不需要限制大小，使用完整的轨迹就行了，策略agent我在前面的回答中说了，好像和诊断agent存在重复了

当前归纳：Diagnosis 可以主动探索需要的 artifact；成功和失败轨迹完整保存、读取时不做人为片段上限；`Strategy Agent` 不存在，Generator 承担生成候选职责。上下文窗口管理仍应通过分页/按需读取，而不是破坏 artifact。

状态：`accepted`（Diagnosis 可主动读取完整、不可变的评测 artifact）+ `clarified`（不截断成功/失败轨迹；不设 Strategy Agent，由 Generator 承担生成职责）。具体只读工具和权限合同随后由 Q24b/Q27b 系列继续收敛。

## 第三轮：候选、种群和 benchmark（Q15–Q22）

### Q15 — Generator 能改到哪一层；candidate package 是什么

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`；同一用户消息索引为 `history.jsonl:3162`）。

决定性问题原文摘录：

> **Q15 — Generator 能改到哪一层**：AutoData 是否允许 Generator 在候选工作区中新增、删除、重组数据清洗/质量评估/选择/配比/训练视图代码？

推荐原文摘录：

> 允许。Generator 输出 `candidate package = manifest + source diff/文件`，可以生成新算子，不限于已有算子目录；但候选必须遵守 AutoData 的 typed port/contract。以下部分固定不可改：DSH 宿主插件、AgentLoop/Session、SWE-bench evaluator、训练执行器的安全边界、权限和持久化控制面。Host 在隔离进程/容器中做语法、类型、契约、回放和资源检查后才运行候选。

用户原答：

> Q15:大致同意你说的，不过你说的 candidate package = manifest + source diff/文件，这是啥意思，相关工作是只生成diff是吗，还是什么。

当前归纳：用户大致同意“可以演化候选代码”，但明确要求先解释 `manifest + source diff/文件` 的含义，并询问相关工作究竟输出 diff 还是完整代码。相关工作形式的比较是助手提供的事实背景，不等于用户已选择某一种表示；代码修改范围和候选表示都仍待确认。

状态：本轮为 `needs-confirmation`；本轮状态后来由 Q23b/Q24b 与 Q27b `superseded`，后者已 `accepted` 修改白名单、隔离 workspace、完整 `CandidateSnapshot` 为执行真相和派生 diff。具体 workspace/tool adapter 与持久化格式仍 `needs-confirmation`；不能把本轮追问改写成“已否定 diff-only”。

### Q16 — “产出新的轨迹”

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。

决定性问题/选项原文摘录：

> **Q16 — “产出新的轨迹”具体指什么**：Generator 修改 harness 后，候选的输出是：
>
> A. 从固定输入轨迹池派生出的新训练视图（筛选、清洗、重排、重加权、配比）
> B. 让模型重新 rollout，生成输入池之外的新轨迹
> C. 第一版支持 A，后续再加 B

推荐原文摘录：

> 推荐 C：先把数据 Harness 的闭集演化跑通，避免把“数据策略变化”和“新轨迹生成模型/环境”混在一起。B 可以作为以后注册的 generation adapter，并单独记录生成模型、环境和成本血缘。

用户原答：

> Q16:选A，同意你说的

当前归纳：第一版是闭集数据策展：筛选、清洗、重排、重加权和配比已有轨迹，不把新 rollout 与策略演化混在一起。

状态：`accepted`。

### Q17 — 候选种群怎样生成和保留

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。

决定性问题/选项原文摘录：

> **Q17 — 候选种群怎样生成和保留**：每轮的 `candidates_per_round=N` 应该怎样落地？
>
> A. 一个 Generator child session 在结构化输出中提出 N 个候选；Host 分别物化、训练、评测，保留 champion、历史最佳和候选 archive
> B. 为 N 个候选各创建一个 Generator child session
> C. Generator 只提出一个候选，N 表示重试次数

推荐原文摘录：

> 推荐 A：上下文一致、调用成本可控，仍能产生多样候选。每轮保留所有不可变候选和证据，至少维护一个 active champion；下一轮 Diagnosis 读取整个人口的结果，Generator 读取诊断、父候选和历史 archive。选择规则先用固定的 benchmark 主指标，平分时再看质量约束、覆盖、成本和多样性。`N` 和 `max_rounds` 是用户可见的两个超参数，`elite/archive` 可以先用固定实现，不再引入第三个必填参数。

用户原答：

> Q17:选A，同意你说的，不过我没看懂：，elite/archive 可以先用固定实现，不再引入第三个必填参数。这个是啥意思，这个等我们讨论之后再固定我不懂的这个点

当前归纳：接受一个逻辑 Generator 可提出多个候选，N 不是隐式重试；但 `elite` 的长期含义和多候选 active population 仍待讨论。后续 Q25b 将第一版收窄为一个 champion 加完整 archive。

状态：`accepted`（一个逻辑 Generator 可提出 N 个候选，N 不是重试次数）；Q25b 后续把 v1 收窄为 `best-so-far champion + immutable archive`，因此 v1 的 elite 问题已关闭；R25 后续明确平分时保留 incumbent、不使用质量、覆盖、成本或多样性作隐藏 tie-break，因此本轮推荐中的二级平分规则已 `superseded`；N>1 时是否拆成多个 child、是否采用多个 active elite 作为未来能力 `deferred`。

### Q18 — role 是否为 DSH child session

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant question event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。后续概念解释位于同一 session 的 assistant event ordinals `3963`、`4070`；这两个解释事件没有被当作新的用户确认。

决定性问题原文摘录：

> **Q18 — 两个 role 是否就是 DSH child session**：是否确认由 AutoData Host 顺序创建 Diagnosis child，读取结构化 Diagnosis 并关闭该 session，再创建 Generator child，读取候选并关闭该 session？

推荐原文摘录：

> 确认。每个 role 有独立 prompt、模型路由、工具白名单、输入/输出 schema 和预算；默认可以共用一个强模型，但配置允许以后分开。Diagnosis 只有只读 artifact 工具，Generator 只有读取诊断/历史和提交候选包的“提案”能力，真正写入和执行仍由 Host 完成。这样它们是 DSH 的子 agent，而不是 AutoData 自己实现第二套 agent runtime。

用户原答：

> Q18:同意你说的，但是我没看懂：，真正写入和执行仍由 Host 完成 这句话，不过角色是 DSH child session 感觉还挺合理，我是这样子理解的，就好比有一个叫做开会的插件，那dsh集成这个插件之后，遇到问题觉得要开会，ok，那就去开会，开会插件里面有可能就是创建child session互相讨论？类似这种意思？

当前归纳：用户认可“开会插件按需创建 child session”这一类比，并表示该模式感觉合理。助手关于完整 AgentLoop、工具权限和生命周期的描述是概念性解释；具体 API 名称、in-process/out-of-process 选择和权限合同仍未验证。

状态：`accepted`（child-session 模式的理解方向）+ `needs-confirmation`（具体运行合同）；不能把示例 `ctx.subagents.start` 当成事实接口。

### Q19 — 多候选轮次的 Diagnosis 视野

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。

决定性问题原文摘录：

> **Q19 — Diagnosis 在多候选轮次看到什么**：首轮它看到 baseline 的评测，后续轮次它是否看到该轮全部候选的结果和完整轨迹？

推荐原文摘录：

> 看到完整的、不可变的 evaluation artifact 索引，并通过只读工具主动取得任意候选的完整原始评测内容、代码摘要和成功/失败轨迹。存储层不截断、不只保留引用；按块读取只是避免一次把数百条轨迹塞爆模型上下文，不改变 artifact 内容。Generator 默认接收 Diagnosis、当前 champion、候选历史和约束，不直接拿 SWE-bench gold patch/test patch。

用户原答：

> Q19:同意你说的

当前归纳：Diagnosis 可以读取不可变 evaluation artifact 索引，并主动获取任意候选的完整原始评测、代码摘要和成功/失败轨迹；存储不截断，分页只解决模型上下文限制。Generator 不直接获得 benchmark gold patch/test patch。

状态：`accepted`。

### Q20 — SWE-bench 版本与反复迭代

初始问题来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。后续 Q20-1/Q20-2 的 assistant event ordinal `6196`（JSONL line `6197`，`2026-09-03T08:55:50.551Z`），对应 user event ordinal `6206`（JSONL line `6207`，`2026-09-03T09:05:55.469Z`）；Q20-1a/Q20-2a/Q20-3 的 assistant event ordinal `6603`（JSONL line `6604`，`2026-09-03T09:30:12.762Z`），对应 user event ordinal `6609`（JSONL line `6610`，`2026-09-03T09:32:33.258Z`）。本节后续 Q20-1b/Q20-1c 的精确来源分别见对应独立条目。

初始决定性问题/选项原文摘录：

> **Q20 — SWE-bench Verified 的反复迭代如何防止过拟合**：官方 Verified 只有一个 `test` split，没有官方 dev。你希望：
>
> A. 从 500 个实例建立内部固定 `search` 与 sealed `final` 子集，迭代只看 search，最后才看 final
> B. 每轮都用全部 500 个实例
> C. 迭代用便宜的内部 proxy，SWE-bench 只在最后完整运行

初始推荐原文摘录：

> 推荐 A 或 A+C 的组合：先用固定、按仓库/问题族分组的 search 子集跑闭环，保留一个不向 role 暴露的 final；正式报告再跑完整 Verified。内部切分要明确标为 AutoData protocol，不能冒充官方 Verified 分数。

助手（未在本台账中独立复核数据集发布资料）指出 Verified 只有 test，给出内部 search/final 切分建议。用户原答：

> Q20:那好像可以再去看看别的swebench，好像swebench是有官方dev和test的？不一定就用swebench verified

后续 Q20-1 的决定性问题/选项原文摘录：

> **Q20-1 — 首个 benchmark profile 与三层切分**：
> A（推荐）. Full 作为进化主 profile；将固定的 225 条 dev 实例划为 `search` 与 `validation`，2294 条 test 只在进化结束后做最终报告；Lite 只用于 smoke/integration；Verified 作为可选外部 final report，不参与晋升。
> B. Lite 作为主 profile。
> C. Verified 作为主 profile，并把它的 test 自行拆成 search/validation。
>
> 如果选 A，还需要决定是 instance-level 分层切分，还是 repo-disjoint 的验证集。

本轮用户原答：

> Q20-1:先用full这个benchmark，然后你说的划分方式我没看懂，后续再次讨论一下
>
> Q20-2-validation: 我有点怀疑到底要不要验证集了，你去看看别人harness自进化的工作吧，如果要验证集，那为什么只提供分数，假设验证集上分数下降了，那么怎么继续自进化，模型又不知道怎么调整，还是说发现验证集分数下降，那就知道自己之前提的假设实际上有问题，相当于就排除了一个错误方案？又可以继续提出新的候选？如果是这样子的话，那感觉验证集也是可以的，有必要，你先去调研一下吧

历史归纳（已被本节后面的 Q20-1 选择替代）：此时 benchmark 选择重新开放，不能把 Verified 写成唯一不可变初始 benchmark。候选 adapter 应可支持不同 SWE-bench profile；Q26a 中关于各变体规模和 Lite 的推荐只是助手报告/建议，不代表用户选择。

本轮核实到的事实（数据集快照 revision 已固定用于本次核对）：

- Full（`SWE-bench/SWE-bench@c6fe717f`）：`dev=225`、`test=2294`，当前命名空间没有官方 train；dev/test 的实例和仓库集合不重叠。
- Lite（`SWE-bench/SWE-bench_Lite@b0dde109`）：`dev=23`、`test=300`，是 Full 的子集；Lite test 与 Verified test 有 93 个实例重叠。
- Verified（`SWE-bench/SWE-bench_Verified@78f471bf`）：`test=500`，是 Full test 的子集，没有官方 dev/search split。因此不适合未经额外设计就承担反复晋升。
- 评测成功需要 patch 应用且所有 `FAIL_TO_PASS` 与 `PASS_TO_PASS` 通过；解析、应用和基础设施失败应与逻辑失败分开记录。

这些事实当时支持继续区分训练层、进化选择层和密封测试层；具体选择随后由 Q20-1/Q20-1b 收敛为 Full dev search + Full test sealed，不再为首版派生独立 promotion validation。

本轮结论：用户已选择 Full 作为首个 benchmark profile；Full dev 的具体拆分暂缓，不能把示例 `80/20` 当成决定。

Q20-1a 重问原文摘录：

> Full 的 225 条 dev，首轮是全部作为 search/dev，还是现在就拆出 promotion validation？

本轮用户后续答复：

> Q20-1a：如果大家都没做验证集的话，感觉就只要训练集和测试集就足够了
>
> Q20-2a:暂时不回答，先讨论要不要验证集
>
> Q20-3:暂时不回答，先讨论要不要验证集

当时归纳：用户倾向采用两层数据边界，但这里的“训练集”需要拆成两个不同概念：`trajectory_train` 是用于训练小模型的输入轨迹；Full 的官方 `dev` 是 benchmark 的 development/search 任务集，不是 SFT 训练集。一个可行的两层 benchmark 协议是“Full dev 反复用于 search/候选选择，Full test 密封到最终报告”，而不是把 test 再拿来调参。此时独立 promotion validation 仍开放，随后由 Q20-1b 明确为首版不启用。

关于验证集的定向调研：

- **CurateEvo** 把固定原始语料分为 train/dev（论文实验约 `9:1`），每轮从同一 base model 和固定 recipe 训练，在 held-out dev 上评测；演化 agent 可看到失败 dev 轨迹、dev 性能、工具/环境诊断和数据统计。若目标没有改善，候选回滚；独立 test 从不参与演化，只用于最终评测。
- **Autonomous Agentic Data Engineering** 采用 public feedback 与 private final evaluation 的两层边界，没有统一的第三个 promotion validation；这说明验证集不是所有系统的必需层。
- **Meta-Harness** 让 proposer 读取历史候选的源码、分数和执行轨迹；公开描述强调完整 traces 比只有分数/摘要更有用，候选仍按 search 反馈选择，test 保持密封。
- **RSIBench-Data** 将 selection feedback 定义为分数、轨迹、verifier 结果、执行诊断和成本，并用历史最佳 checkpoint 防止“后续候选分数下降”覆盖早期强候选；其作者同时指出若选择集与 official 评测使用同一任务子集，就不能声称严格的 held-out 泛化，建议使用 private/refreshed split。

因此，验证分数下降不会让循环停止，也不要求模型凭一个分数猜修复方式。Host 应把候选标记为回归/可能过拟合，保留完整候选和证据，继续以旧 champion 为 parent；Diagnosis 用 search 的完整失败轨迹，加上 validation 的汇总、分片差异和结构化错误信号，判断原假设被否证，再由 Generator 提出下一候选。只给一个总分通常不够，但把 validation 的全部原始轨迹在每轮都暴露也会逐步把它训练成新的 search 集。

状态：`accepted`（首个 profile 为 Full；首版 Full dev 全量用于 search、Full test 密封，不引入独立 promotion validation）+ `needs-confirmation`（最终 test 的精确调用时机与报告协议）。未来是否另开协议增加 validation 是延期能力，不是首版开放选择。

### Q21 — 候选训练和未来质量 stage

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。

决定性问题原文摘录：

> **Q21 — 候选训练的公平比较**：每个候选是否都从同一个小模型 base checkpoint、同一训练 recipe、同一 seed 和同一预算开始？

推荐原文摘录：

> 第一版全部固定，只让候选数据 Harness 变化；冠军候选再做多 seed 重跑。否则模型、训练随机性和数据策略同时变化，Diagnosis 无法归因。

用户原答：

> Q21:同意，不过第一版本的话，打算先把参数定为1，先生成一个候选，然后其实也不一定每次产出新轨迹后就去训练，后面我可能会考虑再引入一些轨迹质量评估的方法，比如加agent或者一些其他方法进来，这样子如果发现产出轨迹的质量不行的话就可以直接快速迭代，而不需要训练，减少了训练成本，当然这个方法是后话，可以记录一下，现在的话我不知道怎么去做

当前归纳：第一版 `candidates_per_round=1`；用户同意固定同一个 base checkpoint、训练 recipe 和 seed。Q21 当时还把“同一预算”作为公平性前提，但 R18/Q28a-10 后续明确选择固定轨迹上限加固定 epoch、允许候选实际 records/tokens/steps 不同，并明确不声称等算力比较，因此 Q21 的“同一预算”部分已被替代。当前候选仍按 Q11 训练/评测。未来可在训练前增加轨迹质量评估 stage；Q29a/R10 后续已确认只预留接口、首版默认关闭。

状态：`accepted`（第一版候选数；固定 base checkpoint、recipe 和 seed）+ `superseded`（同一训练预算主张由 R18/Q28a-10 替代；“冠军候选再做多 seed 重跑”的推荐由 R24 明确延期；质量 stage 已由 Q29a/R10 关闭为“预留接口、首版默认关闭”）。

### Q22 — 失败候选的证据

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `3787`（JSONL line `3788`，`2026-09-03T06:07:33.259Z`）；user event ordinal `3798`（JSONL line `3799`，`2026-09-03T06:25:23.405Z`）。

决定性问题原文摘录：

> **Q22 — 一轮全失败时怎么办**：如果 N 个候选都没有通过 Host gate 或 benchmark 变差，下一轮如何走？

推荐原文摘录：

> 当前 champion 保持 active，所有候选进入 rejected/archive 并保存完整证据；该轮记为 unsuccessful round。默认下一轮仍可从 champion 继续，但达到连续失败上限就停止。这个上限可以先固定为 1，后面再暴露成超参数。

用户原答：

> Q22:同意你讲的，并且如果候选失败的完整证据也可以推动下一次候选的生成对吧

当前归纳：用户确认失败候选的完整证据可以推动下一次候选生成。本轮不能单凭“同意”推出每个 artifact 字段或读取权限；后续 R27 已确认候选问题不做同轮修复、若尚有 round 则由下一轮 Diagnosis → Generator 处理，R28 已确认基础设施故障最多原样重试一次，耗尽后停止 run 且 champion 不变。本轮推荐中的“连续失败上限固定为 1”不能覆盖尚未回答的 Q38；当前 `max_rounds` 默认值和 round 计数仍 `open`。

状态：`accepted`（失败证据保存并反馈给后续 Diagnosis；后续 R27/R28 已关闭同轮修复和基础设施 retry policy）+ `superseded`（固定连续失败上限不再作为独立当前规则）+ `open`（运行轮数由 Q38 待定）。artifact 的具体 JSON schema、索引字段和读取 API 属 implementation-spec pending，不是尚未取得用户同意的研究决策。

## 编号重叠后的 Host 轮（Q23a–Q31a、Q23b–Q27b）

当前会话在不同轮次重复使用了 Q23–Q26 编号。为了不抹平这个事实，本台账把它们分成两组：

- `Q23a–Q31a`：Q22 后的候选协议前沿；来源为 session `01a060d5-6a05-7573-9259-8e535905a19f` 的 assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答，用户未逐项作答。
- `Q23b–Q26b`：用户询问 child/Host 和相关工作后，重新提出的 Host 专项问题；assistant event `4334` 提问，user event `4340` 集体同意，但当时附带候选应用问题。
- `Q27b`：候选物化方式；assistant event `4478` 初问时用户未答，后来 assistant event `6004` 重问、user event `6016` 选择 A 并确认白名单；不能停留在“尚未确认”的历史状态。

### Q23a — 候选包边界

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）。紧接着的 user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确说“你先回答我的问题，然后我再来回答你这些问题”，没有回答 Q23a–Q31a。此处与后来的 Q23b 不同。

决定性问题/推荐原文摘录：

> **Q23 — 候选包的具体边界**：是否采用 `manifest.json + changes.patch（或变更文件列表）+ Host 应用改动后的完整可执行 materialized/ 副本`？Generator 可以新增或修改 `data strategy / cleaning / quality / selection / mixing / training-view` 代码，但不能改 DSH 宿主、benchmark evaluator、训练后端、角色权限或全局配置。
>
> 推荐：是。生成“源码 diff”不是相关工作的唯一形式，但保存 `diff + 完整副本` 同时兼顾审计和重放。它也不需要发布成 npm 包，只是 AutoData 自己的候选 artifact。

用户原答：无。紧接着的 user event 明确要求先回答解释性问题；后续 Q23b 的集体同意覆盖了 Host 边界，但不构成本题当轮回答。

状态：本轮为 `open`（未回答）；本轮提案后来由 Q23b/Q24b/Q27b `superseded`，后者已 `accepted` 候选白名单与 `workspace -> CandidateSnapshot -> derived CandidateDiff` 的高层协议；具体 workspace/tool adapter 和持久化格式仍 `needs-confirmation`。

### Q24a — 一个逻辑 Generator 对应几个 child

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项原文摘录：

> **Q24 — 一个逻辑 Generator role 对应几个 child session**：A. N=1 时一个 Generator child；N>1 时先让一个 Generator child 返回 N 个结构化候选；B. N 个候选创建 N 个 child；C. 永远只创建一个候选。
>
> 推荐：先 A。这样“Generator”仍是一个逻辑 role；以后需要更高多样性时，再把 N 个候选拆成 N 个独立 child session。无论哪种方式，所有 child 都由 Host 创建、限权和回收。

用户原答：无。Q17 的 A 选择为“一个逻辑 Generator 返回 N 个候选”提供支持，但后来的 Q23b–Q26b 讨论的是 Host 形态、候选权限、晋升和技术失败，并未回答本题的 N>1 child fan-out。

状态：本轮为 `open`（未回答）。Q17 已接受“一个逻辑 Generator 可返回 N 个候选”；v1 又由 Q21 固定 `candidates_per_round=1`，因此 v1 只需一个 Generator child。N>1 时是否 fan-out 为多个 child 属未来能力，保持 `deferred`，不应写成已确认。

### Q25a — 第一版种群保留

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项原文摘录：

> **Q25 — 种群到底保留什么**：A. 一个 champion + archive 保存全部候选，暂不启用多个 active elite；B. 同时保留 top-k 个 active 候选；C. 只保留分数最高的候选，删除其他候选。
>
> 推荐 A 作为第一版实现。这不妨碍以后增加多样性/非支配种群；archive 中的失败候选也会被 Diagnosis 看到。`elite` 这个词可以先不进入公开配置，等 N>1 的实验需求出现后再决定。

用户原答：无。Q17 对 elite 表示“等讨论”，因此不能只凭摘要写成完全冻结。

状态：本轮为 `open`（未回答）；该 v1 问题后来由 Q25b 的集体确认 `superseded`，当前已 `accepted` `best-so-far champion + immutable archive`；多个 active elite/N>1 population 保持 `deferred`。

### Q26a — 第一版 SWE-bench profile

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项与推荐原文摘录：

> **Q26 — 第一版选哪个 SWE-bench**：`SWE-bench`（dev=225/test=2294）、`SWE-bench_Lite`（dev=23/test=300）、`SWE-bench_Verified`（只有 test=500）或 `SWE-bench_Multimodal`。
>
> 推荐：Adapter 同时支持这些 profile；第一版真实闭环默认 `SWE-bench_Lite`，因为有官方 dev/test 且成本可控，完成后再切换完整 `SWE-bench`。Verified 不删除，只是不再硬编码成唯一 benchmark。

这里的数量和推荐在当时属于助手报告，不是用户确认；Q20 后续单独核实并选择 Full。

用户原答：无。Q20 明确要求继续调查。

历史状态：`open`。当前状态：`superseded`（Q20-1 后续已选择 SWE-bench Full 作为首个 profile）。

### Q27a — 小模型如何参加 SWE-bench

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项与推荐原文摘录：

> **Q27 — 小模型如何参加 SWE-bench**：A. 用 DSH 的 coding-agent/工具环境运行小模型，收集完整 session trajectory，再交给官方 SWE-bench evaluator；B. 直接使用官方 `swebench infer`/mini-SWE-agent；C. 自己写一个只生成 patch 的简化 runner。
>
> 推荐 A 作为 DSH 集成默认，但把它抽象成接口，所以也能接 B/C。这样 benchmark adapter 只负责任务、评测和结果格式，TaskRunner 负责“模型怎样做题”。

用户原答：无。

历史状态：`open`。当前状态：`superseded`（R9 已确认首版使用 `mini-SWE-agent`，同时保留可替换的 `TaskRunner` adapter）。

### Q28a — 数据配比的表达能力

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项与推荐原文摘录：

> **Q28 — “数据配比”需要表达什么**：A. 只选择/排序，不允许重复采样；B. 按 bucket/source/能力分组，支持 sample weight、重复采样或目标配额；C. 直接生成输入池之外的合成轨迹。
>
> 推荐 B，并仍然遵守 Q16 的闭集原则：第一版不生成新的语义轨迹，只对已有轨迹做过滤、分桶、配额和权重。训练 adapter 再把权重/重复策略编译成 ms-swift 可接受的训练文件。

用户原答：无。

历史状态：`open`。当前状态：`superseded`（R10–R15 已把此问题拆为配比原语、repeat、bucket、`TrainingViewEntry`、weight 和 quota 子问题；以文末快照为准）。

### Q29a — 是否预留质量评估 stage

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/推荐原文摘录：

> **Q29 — 是否现在就预留质量评估 stage**：是否确认把流程做成 `parse -> deterministic data checks -> optional trajectory-quality stage -> train -> task runner -> benchmark evaluator` 的可插入 stage 链？
>
> 推荐：现在就定义 stage 接口，但第一版只实现便宜、确定性的检查；未来的质量 Agent 或其他质量算法作为新 stage 注册，失败时跳过训练。

用户原答：无。Q21 只表达了未来想法。

历史状态：`open`。当前状态：`superseded`（R10 已确认预留通用 quality stage，首版默认关闭，不加入质量评估 agent）。

### Q30a — 稳定 ID 回退链

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/推荐原文摘录：

> **Q30 — 输入记录的稳定 ID**：真实 JSONL 中有些行没有顶层 `id`/`uuid`。是否接受 `explicit id -> uuid -> source -> metadata.source_file + metadata.line_no -> input file hash + physical line number` 的回退顺序？
>
> 推荐：接受；任何最终碰撞都单独 quarantine。只忽略未知的顶层扩展字段，`messages` 内标准字段原样保留。坏行丢弃并记录行号和错误，不影响其他行。

用户原答：无。

历史状态：`open`。当前状态：`superseded`（R19/R22 改为来源中立的内部内容哈希，不采用此处的上游 ID 回退链）。

### Q31a — 失败候选是否隐式修复

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`；原始文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4008`（JSONL line `4009`，`2026-09-03T06:33:06.541Z`）；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）明确暂缓回答整组问题。

决定性问题/选项与推荐原文摘录：

> **Q31 — 失败候选的下一步**：A. 失败候选归档，下一轮 Diagnosis 读取它；不在同一轮隐式修复；B. Host 自动再请求 Generator 修复，修复次数另算；C. Generator 自己循环到通过为止。
>
> 推荐 A：最容易审计，且 `candidates_per_round` 的预算含义清楚。以后要加快速修复，可以把它作为明确的 `repair_stage` 和独立预算，而不是隐藏重试。

用户原答：无。Q22 支持“失败证据推动下一轮”，但不等同于接受完整的 retry policy。

历史状态：`needs-confirmation`。当前状态：`accepted`（R27 已确认冻结后不做同轮 repair；候选问题由下一轮 Diagnosis → Generator 处理）。

## Host 专项轮（Q23b–Q26b）

### Q23b — Host 的形态

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；assistant event ordinal `4334`（JSONL line `4335`，`2026-09-03T06:58:02.667Z`）；user event ordinal `4340`（JSONL line `4341`，`2026-09-03T07:04:39.307Z`）对 Q23b–Q26b 集体回答。

问题与推荐原文摘录：

> **Q23 — Host 运行在哪里**：第一版是否确定为 DSH 进程内的 `EvolutionHost`，重训练和 benchmark 通过 adapter/job 调用？
>
> 推荐该方案：Host 是 AutoData Bundle 内的确定性 controller，不是第三个思考型 Agent；部署最简单，同时保留以后接远程训练/评测后端的能力。

用户原答（对 Q23b–Q26b 的整体回答）：

> Q23-26，我都同意你说的，除了一个地方我有问题：generator生成的修改，host怎么应用下来？这一点别人是怎么做的，我看你刚刚的回答里面好像就是别人都是自己生成一个完整的代码然后拿去跑，而不是补丁？

当前归纳：接受 DSH 进程内 Host + 可替换 job/adapter 的方向。当轮被用户排除在集体确认之外的候选应用方式，后来已由 Q27b 系列关闭为 `workspace → CandidateSnapshot → derived CandidateDiff`；具体 adapter/API 属 implementation-spec pending。

状态：`accepted`（Host 形态；候选应用高层协议后来由 Q27b 系列关闭）。

### Q24b — 候选权限

来源：同一根 session 和文件；assistant event ordinal `4334`（JSONL line `4335`，`2026-09-03T06:58:02.667Z`）；user event ordinal `4340`（JSONL line `4341`，`2026-09-03T07:04:39.307Z`）集体回答。

问题与推荐原文摘录：

> **Q24 — Generator 的修改权限**：Generator 是否可改数据插件源码/配置，但不能改 DSH runtime、训练器、benchmark evaluator、权限和预算配置？
>
> 推荐由 Generator 只写隔离 workspace，Host 应用并同时保存 structured manifest、source diff 与 applied full snapshot。

用户原答：与 Q23b 共享 user event `4340` 的集体回答；逐字原文保留在 Q23b，明确“Q23-26，我都同意”，仅把“Generator 修改如何由 Host 应用”留给 Q27b。

当前归纳：候选修改范围和 Host 的受信任权限边界获用户同意；“如何把修改应用到 parent”当轮转到 Q27b，现已由 Q27b 系列关闭高层协议。

状态：`accepted`（权限边界和后续 Q27b 的应用原则）；具体 workspace adapter、沙箱限额与生命周期为 implementation-spec pending。

### Q25b — 晋升规则

来源：同一根 session 和文件；assistant event ordinal `4334`（JSONL line `4335`，`2026-09-03T06:58:02.667Z`）；user event ordinal `4340`（JSONL line `4341`，`2026-09-03T07:04:39.307Z`）集体回答。

问题与推荐原文摘录：

> **Q25 — 种群保留规则**：是否采用 `best-so-far champion + immutable archive`，候选变差时 champion 不变，所有失败证据仍归档，而不是把最新一代自动当最佳？
>
> 推荐确认，且 v1 不额外引入 active `elite`。

用户原答：与 Q23b 共享 user event `4340` 的集体回答；逐字原文保留在 Q23b。

当前归纳：第一版以一个 champion 为当前父/active 版本，archive 保存所有候选和证据；`elite` 不作为第三个必填用户参数。Q10 的后续回答已选择自动晋升形状，因此“自动激活还是人工 approval”不再开放；比较指标已由 R23、提升阈值和平分处理已由 R25、逐 case guardrail 已由 R26 关闭。未来 N>1 的多 active population 可另行讨论。

状态：`accepted`（champion + immutable archive 原则；Q10 的自动晋升形状；后续晋升细则见 R23/R25/R26）。长期 N>1 population 不属于 v1 当前 frontier。

### Q26b — 技术失败处理

来源：同一根 session 和文件；assistant event ordinal `4334`（JSONL line `4335`，`2026-09-03T06:58:02.667Z`）；user event ordinal `4340`（JSONL line `4341`，`2026-09-03T07:04:39.307Z`）集体回答。

问题与推荐原文摘录：

> **Q26 — 技术失败处理**：编译失败、超时、作业崩溃是否分开处理，只允许基础设施故障有限重试，而逻辑错误直接归档并进入下一轮？
>
> 推荐确认；同一个有逻辑错误的候选不重复训练。

用户原答：与 Q23b 共享 user event `4340` 的集体回答；逐字原文保留在 Q23b。

当前归纳：接受有限基础设施重试、逻辑候选失败归档的方向；错误分类、Agent 职责和同轮 repair 已由 R27 关闭，基础设施重试次数与停止条件已由 R28 关闭。

状态：`accepted`（原则及 R27/R28 的后续精确协议）。

## 解释性追问和 Q27b

### A1 — child agent 是不是 SDK 创建、是否带完整 runtime

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`；同一问题也见 `history.jsonl:3164`）；assistant event ordinal `4070`（JSONL line `4071`，`2026-09-03T06:38:43.324Z`）解释。没有对应的用户选择事件。

用户问题原话：

> 1。child agent是不是通过sdk创建的，这个agent包含了完整agent runtime是不是

助手回答的有效结论：AutoData 应调用 DSH 的公开 Agent/Session API，而不是核心直接调用某一家 LLM SDK。child 是正常 DSH Agent 执行单元，拥有自己的 session、AgentLoop、prompt、model route、工具执行、结构化输出和生命周期；“完整 runtime”不等于所有权限，工具和上下文由 Host 限定。第一版倾向 in-process child，核心只依赖 `RoleRunner` 抽象。

状态：`informational`（概念解释，不等于用户批准实现）；真实 DSH API 名称和 in/out-of-process 选择仍 `needs-confirmation`。

### A2 — 为什么由 Host 写入、检查、运行和决定 champion

来源：同一根 session 和文件；user event ordinal `4019`（JSONL line `4020`，`2026-09-03T06:36:12.128Z`）提问；assistant event ordinal `4070`（JSONL line `4071`，`2026-09-03T06:38:43.324Z`）解释；user event ordinal `4077`（JSONL line `4078`，`2026-09-03T06:46:20.320Z`）仅表示“host这个我理解了”并继续追问 A3。

用户问题原话：

> 2。Host 负责把副本写入候选目录、检查、运行、保存结果和决定是否成为 champion；这个是什么意思，为什么要这样子做

助手回答的有效结论：Host 是 AutoData 插件里的可信控制面，类比 GitHub PR 的分支、CI、merge 和历史 archive。Generator 提交候选；Host 从 parent 创建隔离副本，应用变更，做类型/结构/权限/replay/资源检查，使用固定训练和 benchmark 运行，保存证据，再接受、拒绝或回滚。原因是权限安全、可复现、可回滚、公平比较，以及跨 session/重启持久化。

状态：`informational`（用户表示理解，不构成一项独立设计选择）；Host 的可信控制面和候选生命周期后来由 Q23b、Q27b 与 R27 正式确认。

### A3 — 相关工作的 Host 同类物

来源：同一根 session 和文件；user event ordinal `4077`（JSONL line `4078`，`2026-09-03T06:46:20.320Z`）提问；assistant event ordinal `4334`（JSONL line `4335`，`2026-09-03T06:58:02.667Z`）调研解释。A3 没有对应的用户选择事件；同一 assistant event 后半段另行提出 Q23b–Q26b。

用户问题原话：

> 关于你说的host这个我理解了，别人在做harness自进化的时候是不是也有这种host？他们是怎么做的

核对后的助手归纳：相关工作通常叫 outer loop、orchestrator、controller、experiment runner、archive manager 或 foundry，不一定叫 Host，也不一定是独立服务。Darwin Gödel Machine 有外层脚本维护 archive、选择 parent、在 Docker 中应用修改并评测；Meta-Harness、CurateEvo、HarnessX/AEGIS、HELIX 和 Curation-Bench/RSIBench-Data 也分别体现了候选工作区、固定 evaluator/预算、archive、promotion/revert 或 provenance 的同类职责。论文原型常把它写成脚本/工作流，但功能边界普遍存在。相关工作清单可复核于 [`autonomous-harness-evolution-survey.md`](/root/aris-workspace/docs/2026-08-19-autonomous-harness-evolution-survey.md:17)，其中包含对应论文链接。

状态：`informational`（事实调研和类比本身不需要伪造用户确认）；具体 AutoData 取舍由 Q23b–Q26b、Q27b 与 R27 决定，不把论文脚本直接当接口规范。

### Q27b — Generator 修改如何物化

来源：同一根 session 和文件。assistant event ordinal `4478`（JSONL line `4479`，`2026-09-03T07:11:58.599Z`）初次提出物化方案；user event `4484`（line `4485`，`2026-09-03T07:12:20.096Z`）没有回答设计题，而是转问记录是否完整。assistant event `6004`（line `6005`，`2026-09-03T08:39:04.847Z`）作决定性重问；user event `6016`（line `6017`，`2026-09-03T08:45:53.586Z`；`history.jsonl:3275`）选择 A 并确认白名单。中间 user events `4542`/`4561` 是建立台账的授权，不是 Q27b 回答。

决定性重问、推荐与用户原答逐字保留在 R4；本节保留从初问到最终确认的完整语义演变。

助手先承认需要区分：Generator 可以输出完整源码、文件操作、Git diff 或 typed manifest；Host 运行前必须得到完整、可独立运行的 candidate snapshot。随后提出三层对象：

```text
CandidateProposal  = Generator 的不可信提案
CandidateSnapshot  = Host 应用提案后得到的完整可执行候选（权威执行对象）
CandidateDiff      = Host 从 parent 与 snapshot 派生的审计附件
```

推荐流程：Host 从 champion 创建隔离 workspace，Generator 在受限 workspace 中编辑；Host 计算规范化 diff 和 tree hash，固化完整 snapshot，在干净副本中做检查、训练和 benchmark。若 Generator 直接返回 diff，则先校验 parent revision，再在干净副本应用 diff，之后同样固化完整 snapshot。

用户尚未回答“是否确定采用这一方案”，而是先追问记录是否完整：

> 关于我回答的问题，你有完整记录下来吗，按照grill with doc的方式？

随后明确要求：

> 对的，需要一份完整可追溯的问答过程

本轮用户原答：

> Q27b:确实A选项合理，但是A选项能实现吗？然后，：第一版是只允许修改数据清洗、数据配比、质量检查和训练视图相关目录；禁止修改 DSH runtime、角色权限、benchmark evaluator、训练后端和全局预算；禁止新增未锁定的外部依赖。

本轮确认与可行性说明：A 可以实现，但 DSH child 不会因为创建出来就自动拥有 Host 文件系统的写权限。Host 需要创建隔离 workspace，并在 child scope 注册受限的读/列举/写入/patch 工具，或先让 Generator 返回结构化文件操作，再由 Host 应用。两条路径都应最终固化完整 snapshot；不能直接写 live bundle 或 DSH 安装目录。已核到的 DSH in-process API（`ctx.agents.create/resume`、受限 child scope）支持这种适配，但 AutoData 仍需通过自己的 adapter 封装，不能把旧仓库中的示例调用当成最终公共合同。

用户确认第一版的候选修改白名单：只允许数据清洗、数据配比、质量检查和训练视图相关目录；禁止修改 DSH runtime、角色权限、benchmark evaluator、训练后端和全局预算；禁止新增未锁定的外部依赖。

当前归纳：`CandidateSnapshot` 是 Host 校验后唯一的执行和回滚依据，`CandidateDiff` 是从 parent 与 snapshot 派生的审计附件。Generator 的输出形式可以是 workspace 编辑、结构化文件操作或 patch，但不能改变这两个权威边界。workspace 工具的具体注册方式、snapshot 的持久化格式、锁文件是否完全不可改，以及失败 workspace 的清理策略仍需确认。

状态：`accepted`（A 的物化原则和第一版修改白名单）；`needs-confirmation`（具体 DSH workspace/tool adapter 与持久化协议）。

### Q27b-1 — Generator 如何操作候选 workspace

来源：同一根 session 和文件。assistant event ordinal `6196`（JSONL line `6197`，`2026-09-03T08:55:50.551Z`）提出 Q27b-1；user event `6206`（line `6207`，`2026-09-03T09:05:55.469Z`）追问并倾向 B，但不是最终确认。assistant event `6562`（line `6563`，`2026-09-03T09:28:12.549Z`）以 Q27b-1a 决定性重问；user event `6609`（line `6610`，`2026-09-03T09:32:33.258Z`；`history.jsonl:3277`）明确选择 B-only、无 fallback。

问题、推荐与两次用户原答逐字保留在 R5、R6；本节记录它们收敛后的含义。

用户原答：

> Q27b-1：最终的效果是不是搞成B方案更好？B方案是不是相当于把原始插件镜像过来直接改？

本轮用户原答：

> Q27b-1a：感觉不需要保留fallback吧，就直接用B方式，省的写一堆兼容

这里的 B 是“候选编辑方式”，不是对已安装插件做原地修改。准确流程是：Host 从当前 champion 的完整 snapshot/manifest 建立每个候选独立的 workspace（可以是完整副本、Git worktree 或 copy-on-write overlay），再让 Generator child 在这个副本中编辑；失败时丢弃或归档副本，成功时冻结为新的 snapshot。运行中的 live Bundle、DSH 安装目录和 parent snapshot 都不被直接改写。只复制改动文件也不够，因为跨文件 import、编译和运行时依赖需要完整候选树才能复现。

DSH 事实边界：child session 有自己的 Session/AgentLoop/scope，但不会自动获得 Host workspace 的写权限；Host 必须显式注册受限 workspace 工具并执行路径、符号链接、大小、操作数、时间、网络和依赖限制。`toolFilter` 本身不是完整的权限上限，不能单独替代 Host 的文件边界。

当前归纳：用户决定不保留 `operations[]` fallback，首版直接采用 B 作为 Generator 的 workspace 编辑入口。B 仍然不是“复制后让 agent 改生产插件”：Host 从当前 champion snapshot 建立隔离候选 workspace，给 child 受限文件工具，完成后冻结 snapshot 并在干净副本中验证。为实现 B，Host 必须解决目标 DSH 版本的 workspace/tool registration、路径围栏和进程权限；若这些公开扩展点不足，属于实现阻塞而不是静默退回另一种协议。

状态：`accepted`（首版采用 B、无 fallback；“镜像”仅指隔离候选副本）；`needs-confirmation`（具体 DSH tool registration、workspace 沙箱和锁文件/依赖执行规则）。

### Q27b-1b — B 方式下的工具入口

来源：根 session `01a060d5-6a05-7573-9259-8e535905a19f` 及同一根文件；assistant event ordinal `6725`（JSONL line `6726`，`2026-09-03T09:39:49.958Z`）提出 Q27b-1b；user event `6735`（line `6736`，`2026-09-03T10:31:37.269Z`；`history.jsonl:3279`）选择 A。assistant event `6740`（line `6741`，`2026-09-03T10:32:01.552Z`）只是复述并引出下一问，不是新增确认；同一用户消息也被 replay 到 continuation `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T18-35-17-01a066d6-53f0-7421-a4f5-1c770d960557.jsonl`。

决定性选项、推荐与同一条用户原答逐字保留在 R7。

用户原答：

> Q27b-1b — B：选A

这里的“B”承接上一问的候选 workspace 编辑方式；“A”指在该 workspace 中提供受限文件工具，而不是让 Generator 获得 shell 或生产插件权限。当前共同理解是：Host 从 champion snapshot 建立隔离副本，Generator child 通过受限工具直接编辑副本，Host 再冻结完整 snapshot 并校验、训练和评测；不保留 `operations[]` fallback，也不修改 live Bundle。

受限工具的具体公开接口仍需和目标 DSH 版本核对。实现建议是只暴露 `list/read/write/edit/delete` 这类文件操作，并由 Host 额外执行路径围栏、符号链接检查、文件大小/操作数/时间预算、锁定依赖和无网络规则；这段是待确认的实现建议，不从“选 A”扩展为用户已确认的每个限制数值。

状态：`accepted`（B workspace + A 受限文件入口、无 fallback）；`needs-confirmation`（工具注册 API、精确沙箱限制、锁文件和 workspace 生命周期）。

### Q20-1b — 首版是否启用 benchmark validation

来源：根 session `01a060d5-6a05-7573-9259-8e535905a19f` 及同一根文件；assistant event ordinal `6725`（JSONL line `6726`，`2026-09-03T09:39:49.958Z`）提出 Q20-1b；user event `6735`（line `6736`，`2026-09-03T10:31:37.269Z`；`history.jsonl:3279`）回答。assistant event `6740`（line `6741`，`2026-09-03T10:32:01.552Z`）只是复述并引出下一问，不是新增确认。

决定性选项、推荐与完整用户原答逐字保留在 R7。

用户原答：

> Q20-1b：第一版先不要验证集吧，后面不行的话再换。

当前归纳：对 benchmark 层，第一版不另设独立的 promotion/validation split。暂按两层协议理解：Full 官方 `dev` 全量作为 search/dev，反复用于候选比较和 Diagnosis；Full `test` 保持密封，只在最终效果报告中使用。后续“不行的话再换”表示可以通过新的 run protocol 增加 validation，不把该扩展提前写成当前默认。

这里仍不能把“不要验证集”自动解释成“不做 SFT 训练轨迹的留出集”：`trajectory_train` 是输入轨迹经过清洗和配比后的 SFT 数据；可选的 `trajectory_valid` 属于训练监控层，与 benchmark validation 是不同概念，下一问单独确认。

状态：`accepted`（首版 benchmark 不拆独立 validation；Full dev search、Full test sealed）。本轮留下的 `trajectory_valid` 子问题随后在 Q20-1c/R9 关闭：首版只生成 `trajectory_train`，预留未来扩展接口。

## 决策演变和冲突清单

### 1. Strategy DSH → Generator Agent

早期 Q6/Q7 把第二角色称作 Strategy DSH；用户在 Q8、Q14 明确诊断之后由 Generator 修改清洗/配比策略，不需要独立 Strategy Agent。当前规范名称是 `Generator Agent`，旧术语只保留在历史记录中。

### 2. 声明式策略文档 → 可演化候选代码

早期推荐只生成声明式 `DataStrategy`，用户指出这可能不足以面对未知场景，并要求调查 harness 自进化如何改代码。当前允许候选在受控范围内修改数据清洗、数据配比、质量检查和训练视图代码；Q27b 已确认 workspace→snapshot→派生 diff 的物化原则，但具体工具 adapter 仍待确认。

### 3. 整条含 sub-agent 的轨迹拒绝 → 保留主轨迹

助手最初建议遇到 nested sub-agent 就隔离整条记录；用户明确只读取主 agent，且暂时保留 `developer`。后续 parser 设计必须遵循用户修正，而不是沿用早期严格建议。

### 4. SWE-bench Verified 固定 → benchmark profile 开放 → Full 被选定

早期背景和 ADR-0001 写过“Verified 初始 benchmark”。用户在 Q20 要求继续查看其他 SWE-bench，随后在 Q20-1 选择 Full。ADR-0001 现已标为 `superseded`，ADR-0002 以 `accepted` 状态记录 Full；这条演变保留历史但不再把 profile 写成开放问题。

### 5. Q23–Q26 编号重复

同一会话先在 `ordinal 4008` 使用 Q23a–Q31a，之后在 `ordinal 4334` 又使用 Q23b–Q26b。用户的“Q23-26 都同意”发生在后者，不能错误映射成前者的全部答案。本台账显式保留两组编号。

### 6. 完整源码、patch 和 snapshot 不是互斥选项

相关工作的共同执行对象是完整候选环境；Generator 的提案形式可以不同。Q27b 已确认 snapshot 作为权威执行状态，diff 作为派生审计/复现附件；具体 workspace/tool adapter 仍需确认。

### 7. Benchmark 的 train/validation 术语拆分

用户在 Q10 中提出“dev 里面还要划分训练集和验证集”。这里的“训练集”不能直接沿用 benchmark 训练集一词：小模型训练使用的是输入轨迹池，清洗/配比后形成 `trajectory_train`；SWE-bench 实例只用于 Full dev 的 search 和最终 test。Q20-1b 把首版 benchmark 边界收窄为两层，Q20-1c 又确认首版不设 `trajectory_valid`；两类 validation 都已对首版关闭，未来若启用需建立新协议。

## 历史共享模型快照（R7 时，非最终 spec）

```text
DSH（权威 AgentLoop / Session / Tool / Job runtime）
└── 一个 AutoData Bundle
    ├── core：轨迹、清洗、配比和演化领域逻辑
    ├── adapters：ms-swift、trainer、benchmark、artifact/job 后端
    └── dsh：服务、工具、role 和 child-session 适配

EvolutionHost（AutoData 内部可信控制面）
  -> 读取标准 ms-swift JSONL 主轨迹
  -> 清洗/配比，生成闭集训练视图
  -> 训练小模型并运行可插拔 benchmark
  -> 用 Full dev/search 反复观察/诊断；首版不启用独立 promotion validation；Full test 密封到最终报告
  -> 创建 Diagnosis child，读取完整评测 artifact
  -> 创建 Generator child，提出候选修改
  -> 在白名单 workspace 中由 Generator 直接编辑，Host 冻结 snapshot、校验、训练/评测候选
  -> archive 全部证据，按规则保留 champion
```

在 R7 时，第一版参数已包括 `candidates_per_round=1` 和可配置的 `max_rounds`；第一版只从固定输入池派生 `trajectory_train`，不生成池外语义轨迹，也不启用 `trajectory_valid`。首个 benchmark 是 SWE-bench Full，TaskRunner 是可替换 adapter、默认 `mini-SWE-agent`；quality stage 只预留接口且默认关闭。候选 snapshot/修改白名单、B workspace + A 受限文件入口、首版两层 benchmark 边界和自动晋升形状已确认。当时尚未关闭的 weight/quota、稳定 ID、晋升阈值和失败重试后来分别由 R16、R19/R22、R23–R26 和 R27/R28 关闭；workspace adapter 仍在当前 frontier。

## 历史前沿快照（R7 前，已被文末当前决定索引取代）

以下列表只复原当时尚未得到 R8–R15 回答的状态，不再是当前待答清单。其中 `trajectory_valid`、TaskRunner 和 quality stage 已分别由 Q20-1c、Q27a 和 Q29a 关闭。

1. **Q20-1c：SFT 训练层是否拆 `trajectory_valid`**：首版是否只生成 `trajectory_train`，关闭 SFT eval/early stopping；或保留可选留出接口但默认关闭。
2. **Q27b-1c：workspace/tool adapter 细节**：B+A 入口的工具注册 API、路径围栏、锁文件/依赖规则、文件大小/操作数/时间预算和 workspace 生命周期如何落地。
3. **Q27a：TaskRunner**：DSH coding-agent、官方 runner，或可插拔默认实现。
4. **Q28a：数据配比**：bucket、权重、重复采样、配额和 ms-swift 导出语义。
5. **Q29a：质量 stage**：接口现在预留到什么程度，质量失败是否跳过训练。
6. **Q30a：稳定 ID**：标准字段、回退链、碰撞和 quarantine 契约。
7. **Q31a/Q26b：失败与基础设施重试**：错误分类、预算、恢复和停止条件。
8. **Q20-2a/Q20-3（未来 validation 扩展）**：若后来启用 validation，反馈暴露和回归后的控制流如何定义；当前不阻塞首版两层协议。
9. **Q10-1：晋升细则**：Full dev 的比较/阈值、平分处理和最终 test 的一次性报告协议。
10. **DSH 公共 API 事实核对**：把 child session/RoleRunner 映射到实际公开 API，不把示例 API 名称写死（已获得初步事实，仍需绑定目标 DSH 版本）。

完成这些问题并得到用户明确确认后，才可以把未决结论提炼回 `CONTEXT.md`、必要的 ADR 和实现计划。Q5 的“清理活动仓库 BFCL 专属内容”本身已经确认，但本次回顾不执行该清理；其余整体重构和实验实现不得依据未决方案直接实施。

## 本次回顾记录

### R1 — 恢复会话并建立台账

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。user event ordinal `4484`（JSONL line `4485`，`2026-09-03T07:12:20.096Z`）先询问记录是否完整；assistant event ordinal `4536`（JSONL line `4537`，`2026-09-03T07:14:47.980Z`）说明缺口并提出补建台账；user event ordinal `4542`（JSONL line `4543`，`2026-09-03T07:15:38.230Z`）确认；user event ordinal `4561`（JSONL line `4562`，`2026-09-03T07:16:10.836Z`）要求读取本地 session 完整回顾；assistant event ordinal `4824`（JSONL line `4825`，`2026-09-03T07:28:24.829Z`）给出最终整理方案；assistant event ordinal `4896`（JSONL line `4897`，`2026-09-03T07:35:45.939Z`）报告台账已落盘并说明重复编号处理。

用户要求原文：

> 关于我回答的问题，你有完整记录下来吗，按照grill with doc的方式？
>
> 对的，需要一份完整可追溯的问答过程
>
> 你现在去完整的回顾我们的对话以及可以直接查看本地session里面存的我们上下文的记录

助手建议原文：

> 在继续实现之前，应该先补一份访谈决策日志，并把过时或冲突的 ADR/阶段文档标记清楚；后续每轮回答后立即同步，而不是只依赖会话上下文。
>
> 我会写三部分：①会话来源与还原规则；②按时间顺序的 Q1–Q31 逐题记录（保留你的原答，标明我当时的建议和当前状态）；③决策演变与未决前沿。

已执行：读取当前设计 session、历史 AutoData session、`history.jsonl`、仓库 `CONTEXT.md`/ADR/阶段文档，并只把与 AutoData 设计有关的内容整理到本台账。原始系统提示、加密 reasoning、凭据和无关运行产物没有复制进项目。

结果：Q1–Q22、两组重复编号的 Q23–Q26、Q27a–Q31a、Q27b 均已登记；每项都区分用户原答、助手建议、当前归纳和状态。未回答的问题保持 `open`/`needs-confirmation`，没有因为“回顾完成”而变成默认同意。

状态：`accepted`（记录动作完成）；设计访谈整体仍为 `进行中`。

### R2 — 本次复核与来源对照

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。本次复核承接 user event ordinal `4542`（JSONL line `4543`，`2026-09-03T07:15:38.230Z`）和 user event ordinal `4561`（JSONL line `4562`，`2026-09-03T07:16:10.836Z`）的授权；assistant event ordinal `4961`（JSONL line `4962`，`2026-09-03T07:39:33.289Z`）发起交叉复核；assistant event ordinal `5044`（JSONL line `5045`，`2026-09-03T07:42:18.100Z`）确认存在完整 transcript；证据捕获事件 ordinal `5047`（JSONL line `5048`，`2026-09-03T07:42:22.563Z`）形成下述固定前缀。本条没有新的用户选择事件。

复核任务原文：

> 我会把当前会话、历史 AutoData 会话、`/root/.codex/history.jsonl` 以及仓库里的设计文档交叉核对，确认哪些是已定决策、哪些是演变中的结论、哪些仍未决，并检查现有台账是否覆盖完整。先做只读审阅，不改业务代码。

复核结论原文：

> 我已经确认本机确实有完整原始 transcript，而不是只有摘要：当前设计会话与历史会话都可逐事件读取，`history.jsonl` 还能作为跨会话索引。接下来我会逐条抽取设计问答原文，特别核对重复编号和后续澄清，避免把早期被推翻的建议当成最终决定。

本次回顾建立的固定前缀截至 ordinal `5047`（5,048 行、49,049,850 bytes），SHA-256 为 `24c56c1466731863199f1e901d3fed3b7bc3ff40f424c54ca1442093bcc973b1`。这是可复核的历史前缀，不是 session 文件当前总长度；后续事件只应追加新的捕获点。本次还读取了飞书 wiki revision `303`，并核对了仓库中的 `CONTEXT.md`、ADR 和历史阶段文档。

已核对：在上述 B 捕获前缀内，当前 session 在 Q27b 之后没有新的用户答复；最后一个直接相关答复仍是用户要求建立“完整可追溯的问答过程”。因此 **在该历史捕获点** Q27b 仍为 `open`，不能从“回顾完成”推导为同意；它后来由 R4 的明确回答关闭。随后出现的范围澄清已单独记录在 R3。飞书 revision `303` 的 BFCL/tau2 等内容已按方法层/实验工作方案分层记录在“跨来源对照”，没有复制实验产物或覆盖本地用户原答。

状态：`accepted`（本次取证和对照完成）；代码实现和未决设计仍未启动。

### R3 — 用户确认访谈起点

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `5654`（JSONL line `5655`，`2026-09-03T08:08:58.885Z`）提议补入更早的演变背景；user event ordinal `5690`（JSONL line `5691`，`2026-09-03T08:13:16.538Z`；同一句话也见 `history.jsonl:3272-3273`）否决该扩展；assistant event ordinal `5702`（JSONL line `5703`，`2026-09-03T08:17:40.269Z`）复述边界。

助手提议原文（摘录）：

> 交叉核对后发现，早期会话里还有一条重要的决策演变链：最初把整个清洗 pipeline 作为研究对象，后来明确用 DSH 作为运行基座、外部轨迹池作为输入，并最终收敛到现在的两角色闭环。现有台账已覆盖当前 Q1–Q27，但我会把这条早期演变也补成“历史背景”。

用户原答：

> 不用，访谈就是从我开始说下载skill那边开始

当前归纳：本次台账的正文边界固定为用户提出安装 `grill-with-docs` 的消息（`history.jsonl:3131`）及其后续访谈。3131 之前的消息即使与 AutoData、轨迹或旧研究有关，也不在本次问答整理范围内；不因它们与当前设计相关而补录。重复消息视为一次范围确认，不产生新的设计决定。

状态：`accepted`（范围澄清）+ `superseded`（助手把 skill 安装前的早期演变补入访谈正文的提议）。在该历史时点，这项澄清没有替代 Q27b、Q10、Q20 的回答，也不授权开始实现；这些设计节点后来分别由 R4 及后续记录关闭或收窄。

### R4 — Q27b/Q10 回答与 benchmark 事实核对

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6004`（JSONL line `6005`，`2026-09-03T08:39:04.847Z`）提出 Q27b/Q10；user event ordinal `6016`（JSONL line `6017`，`2026-09-03T08:45:53.586Z`；`history.jsonl:3275`）回答；assistant event ordinal `6196`（JSONL line `6197`，`2026-09-03T08:55:50.551Z`）解释可行性和 benchmark 分层。当时的 DSH API 事实核对来自历史只读源码与文档；SWE-bench 数量和交集来自已固定 revision 的数据集卡片/机器可读快照。两类外部资料只作为事实证据，不替用户做设计选择，也不改变 `/root/autodata` 是唯一活动实现仓库。

问题与推荐原文：

> **Q27b — 候选修改的物化协议**：Generator 产出的东西，哪一个是 Host 最终执行、归档和回滚的权威对象？
>
> **A（推荐）**：Host 从 parent 创建隔离 workspace，Generator 在受限 workspace 中编辑；Host 完成校验后固化一份完整 `CandidateSnapshot` 作为执行对象，并从 parent 与 snapshot 派生 `CandidateDiff` 作为审计附件。Generator 可以通过结构化文件操作、完整文件或 patch 提案，但这些都不是最终真相。
>
> **Q10 — 候选何时成为 champion**：Host 校验和评测后，怎样决定是否替换当前 champion？
>
> **A（推荐）**：只在候选通过确定性检查且 development split 指标严格优于当前 champion 时自动晋升；test split 只做报告，不参与晋升；无提升、平分或失败都保留旧 champion，并把候选和完整证据放入 archive。

用户原答：

> Q27b:确实A选项合理，但是A选项能实现吗？然后，：第一版是只允许修改数据清洗、数据配比、质量检查和训练视图相关目录；禁止修改 DSH runtime、角色权限、benchmark evaluator、训练后端和全局预算；禁止新增未锁定的外部依赖。
>
> Q10:选A，但是感觉dev里面还要划分一下训练集和验证集？防止一直在过拟合，最后的测试集用来作为最终的效果测试？

用户确认：Q27b 选择 A，并接受第一版候选修改白名单和全部禁止项；Q10 选择 A，同时提出把 dev 再拆为训练集/验证集以防过拟合、把 test 留作最终效果测试。

已形成的共同理解：候选的完整 snapshot 是执行真相，diff 是派生审计附件；sealed test 不参与日常调参。此轮曾建议 Host 自动晋升依赖 search 之外的独立 validation，并使用 `search split`、`validation split`、`sealed test split` 三层术语。

后续替代：Q20-1/Q20-1b/R7 明确把首版改为两层 benchmark 协议——Full dev 全量用于反复 search 和候选比较，Full test 密封，不设独立 promotion validation。因此“自动晋升必须依赖 search 之外验证证据”的结论已经 `superseded`；自动晋升形状本身仍由 Q10 保留。

状态：`accepted`（Q27b A、修改白名单、Q10 自动晋升形状和 sealed-test 方向）+ `superseded`（R4 的独立 validation 要求及当时尚未选 profile 的状态）。

### R5 — B 方案语义与验证集调研

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6196`（JSONL line `6197`，`2026-09-03T08:55:50.551Z`）提出 Q27b-1/Q20-1/Q20-2；user event ordinal `6206`（JSONL line `6207`，`2026-09-03T09:05:55.469Z`；`history.jsonl:3276`）回应并要求调研；assistant event ordinal `6562`（JSONL line `6563`，`2026-09-03T09:28:12.549Z`）报告调研并重问。相关工作核对包括 [CurateEvo](https://arxiv.org/abs/2607.06140)、[Autonomous Agentic Data Engineering](https://arxiv.org/abs/2605.30407)、[Meta-Harness](https://arxiv.org/abs/2603.28052)、[RSIBench-Data](https://arxiv.org/abs/2607.25886) 及仓库内的 [`autonomous-harness-evolution-survey.md`](/root/aris-workspace/docs/2026-08-19-autonomous-harness-evolution-survey.md:17)。

决定性问题与当时推荐原文（摘录）：

> ❓ **Q27b-1 — Generator 如何操作 workspace**：
>
> - **A（推荐的首版实现）**：Generator child 返回类型化的 `operations[]`（读、写、新建、删除、patch），Host 在隔离 workspace 中逐项校验并应用；以后可再把这些操作暴露成受限 DSH 工具。
> - B：首版就给 child 注册受限 `read/list/write/patch` 工具，让它直接编辑 workspace。
>
> ❓ **Q20-1 — 首个 benchmark profile 与三层切分**：
>
> - **A（推荐）**：Full 作为进化主 profile；将固定的 225 条 dev 实例划为 `search` 与 `validation`（例如按 instance ID 固定的 80/20 分层切分），2294 条 test 只在进化结束后做最终报告。
>
> ❓ **Q20-2 — validation 证据对两个 child 的可见性**：
>
> - **A（推荐）**：Diagnosis/Generator 每轮可读取 `search` 的完整评测和轨迹；`validation` 只向 Host 暴露分数/汇总，直到本轮晋升决定后才可查看细节；`test` 在最终报告前完全不可见。

用户原答：

> Q27b-1：最终的效果是不是搞成B方案更好？B方案是不是相当于把原始插件镜像过来直接改？
>
> Q20-1:先用full这个benchmark，然后你说的划分方式我没看懂，后续再次讨论一下
>
> Q20-2-validation: 我有点怀疑到底要不要验证集了，你去看看别人harness自进化的工作吧，如果要验证集，那为什么只提供分数，假设验证集上分数下降了，那么怎么继续自进化，模型又不知道怎么调整，还是说发现验证集分数下降，那就知道自己之前提的假设实际上有问题，相当于就排除了一个错误方案？又可以继续提出新的候选？如果是这样子的话，那感觉验证集也是可以的，有必要，你先去调研一下吧

调研后的推荐原文：

> B 作为最终的 Generator 交互方式更好。它就是把当前 `champion snapshot` fork/镜像成一个隔离的候选 workspace，让 Generator 像开发者一样读写多文件；但它绝不是修改正在运行的插件。Host 最后冻结 workspace 为完整 snapshot，再做检查、训练、评测和晋升。

本轮确认与解释：

- 用户倾向把 B 作为最终 Generator 编辑方式；“镜像”被限定为从当前 champion snapshot 建立隔离候选副本，再在副本上修改，不是修改正在运行的插件。
- 相关工作并没有统一要求第三层 validation：常见形态是反复 search/dev feedback 加密封 final/private test；CurateEvo 使用 held-out dev 的完整失败轨迹和统计，RSIBench-Data 使用丰富 selection feedback 并保留历史最佳 checkpoint。
- 验证集分数下降应被视为对候选假设的否证或回归证据，而不是停止信号：旧 champion 保持，候选完整归档，Diagnosis 判断过拟合/假设错误/随机波动，Generator 从旧 champion 继续提出候选。
- 只暴露一个 scalar 分数会削弱诊断；但每轮暴露 validation 的全部原始轨迹又会使它逐渐变成新的 search 集。候选反馈的粒度和是否设独立 promotion validation 仍待用户决定。

当轮状态：`accepted`（Full 首个 profile）+ `clarified`（B 指隔离候选副本，不是修改 live Bundle）+ `open`（B 是否为首版唯一入口、validation 是否独立存在、反馈可见范围和停止/晋升细则）。后续 Q27b-1a 与 Q20-1b/R7 已分别关闭 B-only 和首版无独立 validation；本条仅保留历史演变。

### R6 — B-only 与两层 benchmark 倾向

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6562`（JSONL line `6563`，`2026-09-03T09:28:12.549Z`）提出 Q27b-1a/Q20-1a/Q20-2a/Q20-3；user event ordinal `6609`（JSONL line `6610`，`2026-09-03T09:32:33.258Z`；`history.jsonl:3277`）回答；assistant event ordinal `6616`（JSONL line `6617`，`2026-09-03T09:33:18.910Z`）澄清“两层”术语。

决定性问题与推荐原文（摘录）：

> ❓ **Q27b-1a — 首版的编辑入口**：
>
> - **A（推荐）**：最终采用 B 的受限 workspace 编辑；同时保留 `operations[]` 作为兼容 fallback。两种入口都由 Host 生成同样的完整 snapshot。
> - B：只实现受限 workspace 工具，不保留 fallback。
>
> ❓ **Q20-1a — Full 的 dev 如何组织**：
>
> - **A（推荐的正式协议）**：预先从 225 条 dev 固定划出 `search` 和 `promotion validation`；比例和分层方法下一轮再定。
> - **B（推荐的首轮 smoke 模式）**：首轮先把全部 225 条 dev 当作 search/dev，不再拆 validation；等 `max_rounds` 大于 1 或候选数增加时再启用第三层。
>
> ❓ **Q20-2a — validation 反馈给谁、到什么粒度**：
>
> - **A（推荐）**：validation 的完整轨迹始终保存；运行中给 Host 和 Diagnosis 一个聚合分数、按 repo/错误类型的 delta、verifier/执行错误分类，不把 raw validation 轨迹和 gold 暴露给 Generator；search 的完整轨迹照常提供。
>
> ❓ **Q20-3 — validation 回归后的控制流**：
>
> - **A（推荐）**：候选标记为 rejected/regression，完整归档；旧 champion 不变；继续生成下一候选，直到 `max_rounds`、预算或明确停止条件。
> - B：第一次 validation 回归就停止整个演化。
> - C：在同一轮无限重试同一个候选。

用户原答：

> Q27b-1a：感觉不需要保留fallback吧，就直接用B方式，省的写一堆兼容
>
> Q20-1a：如果大家都没做验证集的话，感觉就只要训练集和测试集就足够了
>
> Q20-2a:暂时不回答，先讨论要不要验证集
>
> Q20-3:暂时不回答，先讨论要不要验证集

当前归纳：首版不保留 `operations[]` fallback，Generator 直接通过受限 workspace 工具编辑候选副本；这使目标 DSH 的 workspace/tool registration 成为必须满足的前置条件。用户倾向采用两层 benchmark 边界，但“训练集”必须进一步澄清为 `trajectory_train`（SFT 输入轨迹）与 Full 官方 `dev`（benchmark search/dev 任务集）两个不同概念；Full `test` 仍作为最终密封集。validation 是否作为第三层、其反馈暴露和回归后的控制流暂不回答。

当轮状态：`accepted`（B-only 方向、Full profile）+ `open`（B 工具和沙箱细节、两层/三层 benchmark、validation 反馈与回归控制流）。后续 R7 已关闭首版 benchmark 的两层协议；workspace 细节继续由 Q27b-1b–1d 收敛。

### R7 — Q27b-1b/Q20-1b 与 `trajectory_train` 术语澄清

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6725`（JSONL line `6726`，`2026-09-03T09:39:49.958Z`）提出 Q27b-1b/Q20-1b；user event ordinal `6735`（JSONL line `6736`，`2026-09-03T10:31:37.269Z`；`history.jsonl:3279`）回答；assistant event ordinal `6740`（JSONL line `6741`，`2026-09-03T10:32:01.552Z`）确认并引出 `trajectory_train` 澄清。同一 user 消息也可在 continuation `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T18-35-17-01a066d6-53f0-7421-a4f5-1c770d960557.jsonl` 的 event ordinal `4`（JSONL line `5`，该 replay 事件时间 `2026-09-03T10:35:17.362Z`）复核；该 continuation 的 `session_meta.payload.session_id` 仍指向根 session。`history.jsonl` 截至该消息的前缀为 3,279 行、453,710 bytes（exclusive），SHA-256 `40228b73e79be98cfa3b01087f5614ec1d5c352c25b05589a3f6b981efa32d43`。

决定性问题与推荐原文（摘录）：

> ❓ **Q27b-1b — B 方案的精确定义**：
>
> B 不是“开放一个 shell 让 child 随便改”，而是 Host 从当前 champion snapshot fork 出完整候选 workspace，给 Generator child 注册受限的 `read/list/write/edit/delete` 文件工具；只有白名单目录可写，其他基线文件只读。
>
> - **A（推荐）**：按上面的受限 workspace 工具实现 B；允许在白名单目录内新增、删除和修改文件。
> - B：允许 child 在 workspace 内执行 shell。
> - C：只允许修改现有文件，不允许新增/删除文件。
>
> ❓ **Q20-1b — 首版是否采用两层 benchmark 协议**：
>
> - **A（推荐）**：`trajectory_train` 用于 SFT；Full 的全部 225 条 dev 作为 `benchmark_dev/search`，反复提供选择反馈；Full 的 2294 条 test 密封，只在最终 champion 冻结后评测一次。暂不启用第三层 validation，但接口预留给未来多轮运行。
> - B：现在就把 225 条 dev 固定拆成 `search + promotion_validation`。

用户原答：

> Q27b-1b — B：选A
>
> Q20-1b：第一版先不要验证集吧，后面不行的话再换。然后你说的：trajectory_train 用于 SFT；这句话什么意思

本轮用户确认 B workspace 方式配合 A 受限文件工具入口，并明确首版 benchmark 不设独立 validation。为避免“训练集”歧义，术语解释固定为：输入标准 ms-swift JSONL 轨迹池经过清洗、筛选和配比后形成 `trajectory_train`；SFT trainer 用它训练小模型，产出 checkpoint；随后用 Full dev 做 search/诊断，再把 Full test 留作密封的最终评测。`trajectory_train` 不是 SWE-bench 任务集，也不是评测结果。是否同时不拆 SFT 层的 `trajectory_valid`，留作下一问。

状态：`accepted`（本轮两个高层选择与术语边界）。当时开放的 SFT validation 已由 Q20-1c/R9 关闭；其余项目按后续各轮继续演进。

## 历史前沿快照（R7 后，已被 R8–R15 和文末当前决定索引取代）

以下问题是 R7 之后当时重新计算出的 frontier；它们保留为问答轨迹，不是当前待答清单。Q20-1c、Q27a 和 Q29a 后来已经关闭，Q28a 已拆成后续子问题。

### Q20-1c — `trajectory_valid` 是否在首版启用

`trajectory_valid` 是从输入轨迹池留出的 SFT 训练监控数据，只用于 loss、early stopping 或训练期比较；它不是 SWE-bench validation。推荐 A：首版只生成 `trajectory_train`，不拆 `trajectory_valid`，使用固定的训练步数/epoch 并关闭 SFT eval/early stopping，但在接口中预留将来启用留出集的字段。B：首版就拆出并使用 `trajectory_valid`。

用户选择：A。第一版只生成 `trajectory_train`，固定训练步数/epoch，不启用 SFT eval 或 early stopping；未来仍可通过接口增加留出集。

### Q27b-1c — B+A workspace 的具体沙箱

推荐 A：只开放 `list/read/write/edit/delete` 文件工具，严格限制在已确认的清洗、配比、质量检查和训练视图目录；不允许 shell、网络、安装依赖、动态加载；锁文件和依赖版本保持不可变；Host 冻结 snapshot 后回收临时 workspace，同时保留 snapshot、diff 和日志。B：允许 Generator 修改依赖声明或安装新依赖，以换取更大的代码演化空间，但会扩大安全和复现边界。

### Q27a — TaskRunner 的第一版默认

`TaskRunner` 负责让训练后的小模型尝试 SWE-bench 任务并记录完整交互轨迹；独立的 benchmark evaluator 再负责判分。推荐 A：用 DSH 的 coding-agent/工具环境承载模型尝试，用官方 SWE-bench evaluator（或其等价固定 runner）判分，并把两者包成可替换 adapter。B：整个尝试和评分都交给官方 `swebench`/mini-SWE-agent 工作流；C：自写只产出 patch 的 runner。

用户选择：使用 `mini-SWE-agent`，后续可能替换其他 harness。这里的选择只决定第一版 TaskRunner；Generator child 的工具权限是另一个问题。

### Q28a — 数据配比的表达能力

推荐 A：在闭集输入池内支持按 bucket/source/能力标签加权、重复采样和目标配额，并输出确定性的 `trajectory_train`；不生成池外语义轨迹。B：只支持筛选和排序。C：首版就允许 rollout/合成新轨迹。

### Q29a — 质量 stage 是否现在预留

推荐 A：现在定义可插拔的 `quality` stage 接口，但首版只运行便宜的确定性检查；质量不合格时在训练前终止该候选并归档证据。B：首版就加入质量评估 agent。C：完全不预留 stage。

用户追问：如果第一版不预留，后面是否还能加回来？答案是可以，但需要修改流程编排、配置/产物状态和测试；是否现在预留仍待选择。

历史状态：Q20-1c 已由用户选择 A；Q27a 已选择 `mini-SWE-agent`。当时 Q27b-1c、Q28a 和 Q29a 仍 `open`；后续 R10–R15 已继续关闭或拆分这些节点，以文末快照为准。

### R8 — 训练层、TaskRunner 与 Generator 工具权限调研

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6989`（JSONL line `6990`，`2026-09-03T10:45:20.226Z`）提出 Q20-1c/Q27b-1c/Q27a/Q28a/Q29a；user event ordinal `6996`（JSONL line `6997`，`2026-09-03T10:56:24.435Z`；`history.jsonl:3280`）作答并要求调研；assistant event ordinal `7170`（JSONL line `7171`，`2026-09-03T11:04:42.246Z`）和 ordinal `7269`（JSONL line `7270`，`2026-09-03T11:09:00.564Z`）报告调研边界；assistant event ordinal `7348`（JSONL line `7349`，`2026-09-03T11:13:14.442Z`）给出完整解释、调研结论和下一轮问题。

触发调研的问题与推荐原文（摘录）：

> ❓ **Q27b-1c — Generator workspace 的沙箱**
>
> ➡️ 推荐 A：只开放 `list/read/write/edit/delete` 文件工具；限制在清洗、配比、质量检查和训练视图目录；不允许 shell、网络、安装新依赖、动态加载；锁文件和依赖版本不可修改。
> B：允许 Generator 修改依赖声明或安装新依赖，换取更大的代码修改空间。
>
> ❓ **Q27a — TaskRunner 的第一版实现**
>
> ➡️ 推荐 A：用 DSH coding-agent/工具环境运行小模型，用官方 SWE-bench evaluator 判分，并将两者封装成可替换 adapter。
> B：完整调用外部 `swebench`/mini-SWE-agent 工作流。
> C：自己写只生成 patch 的 runner。
>
> ❓ **Q28a — 数据配比能力**
>
> ➡️ 推荐 A：在固定输入轨迹池内支持按 bucket、source、能力标签加权，支持重复采样和目标配额，最终生成确定性的 `trajectory_train`。
> B：只支持筛选和排序。
> C：第一版就允许生成新的 rollout/合成轨迹。
>
> ❓ **Q29a — 是否现在预留质量评估 stage**
>
> ➡️ 推荐 A：现在定义可插拔的 `quality` stage，但第一版只运行便宜的确定性检查；质量不合格就跳过训练并归档证据。
> B：第一版就加入质量评估 agent。
> C：完全不预留这个 stage。

用户原答：

> Q20-1c：选A
>
> Q27b-1c:这个看看别人是怎么做的，会不会让generator联网，使用shell，下载依赖之类的，目前我回答不了这个问题
>
> Q27a：使用mini-SWE-agent吧，后续我可能会换别的harness
>
> Q28a：解释一下选项A
>
> Q29a：如果现在不预留的话，后面改动的时候能加回来吗？

本条的调研结论原文：

> 相关系统没有统一答案。以 Meta-Harness、CurateEvo 这类 coding-agent proposer 为例，shell/文件编辑很常见；网络通常不是显式能力，依赖更常见的是预装、锁定并由外层 sandbox 管理。`mini-SWE-agent` 本身确实是 bash 驱动，但这主要描述“执行 SWE 任务的小模型”，不能直接推导出 Generator 也应拥有无限制 shell。

相关工作与实现事实核对：

- [Meta-Harness reference repository](https://github.com/stanford-iris-lab/meta-harness)：`reference_examples/terminal_bench_2/meta_harness.py` 的 proposer 默认允许 `Read/Glob/Grep/Agent/Write/Edit/Bash`；`claude_wrapper.py` 通过 Claude Code CLI 启动，并关闭插件/MCP，候选写入 `agents/`，外层 Harbor 在 Runloop/Modal sandbox 中评测。默认工具列表没有 `WebSearch/WebFetch`，但 Bash 是否能访问网络取决于运行环境；wrapper 本身没有声明一个通用的网络隔离策略。
- [Meta-Harness proposer skill](https://github.com/stanford-iris-lab/meta-harness/blob/main/reference_examples/terminal_bench_2/.claude/skills/meta-harness-terminal-bench-2/SKILL.md)：允许候选在指定 agent 文件中自由改写 Python，但禁止改外层 loop、evaluator 和 wrapper，并要求不要无理由加入重依赖、运行语法检查和轻量 dry-run。
- [CurateEvo](https://arxiv.org/abs/2607.06140)：论文说明 code-evolution agent 使用 GPT-5.4 配合 `mini-SWE-agent`；其提示约束禁止重依赖、禁止改 raw/dev/test/evaluator/tests，并要求 syntax check 和 dry-run，但论文没有给出“允许任意外网”的结论。
- [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)：agent 的原生动作是 bash；既支持直接本机执行，也支持 Docker、Singularity/Apptainer、bubblewrap/contree 等环境。Docker/远程环境负责准备镜像和依赖，官方 evaluator 只消费模型提交的 patch；因此“TaskRunner 使用 bash”不等于“Generator 可以在宿主机任意安装依赖”。
- [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve)：另一类纯代码进化系统由 LLM 返回候选源码，Host 负责评测，shell 不是 proposer 的必需接口；这说明不存在唯一的行业惯例。

基于这些证据的工程推断是：shell 在 coding-agent 型 proposer 中很常见；无限制网络和运行时下载依赖不是共同必需条件，通常由预构建镜像、锁定依赖、远程 sandbox 或外层 Host 控制。这个推断不替用户关闭 Q27b-1c。

用户本轮选择/问题的当前状态：

- Q20-1c 选择 A：第一版不拆 `trajectory_valid`，固定训练步数/epoch，不启用 SFT eval/early stopping；未来仍可通过接口增加。
- Q27a 选择 `mini-SWE-agent` 作为第一版 TaskRunner，未来应保留可替换 runner adapter；mini 的完整消息轨迹和 SWE-bench evaluator 所需 patch 需要分别归档。
- Q28a 用户要求解释“bucket + 权重 + 重复采样 + 配额”的含义，尚未选择。
- Q29a 用户询问质量 stage 是否可后加，尚未选择；答案是可以，但现在预留通用 stage 边界会显著降低后续改动范围。

状态：`informational`（权限与相关工作调研）+ `accepted`（Q20-1c、Q27a 的用户选择，详见 R9）+ `open`（当时的 Q27b-1c、Q28a、Q29a；后续分别由 R10、R10a–R15 收敛）。

### R9 — Q20-1c/Q27a 确认、Q28a 解释与 Q29a 可演进性

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `6989`（JSONL line `6990`，`2026-09-03T10:45:20.226Z`）提出问题；user event ordinal `6996`（JSONL line `6997`，`2026-09-03T10:56:24.435Z`；`history.jsonl:3280`）在同一消息中回答 Q20-1c、Q27b-1c、Q27a、Q28a 和 Q29a；assistant event ordinal `7348`（JSONL line `7349`，`2026-09-03T11:13:14.442Z`）解释 Q28a/Q29a 并给出权限调研结论。

决定性问题与推荐原文（摘录）：

> ❓ **Q20-1c — SFT 是否拆 `trajectory_valid`**
>
> ➡️ 推荐 A：第一版只生成 `trajectory_train`，不拆 `trajectory_valid`，使用固定 epoch/step，不启用 SFT eval 和 early stopping；接口保留以后增加 `trajectory_valid` 的能力。
> B：第一版就拆出并使用 `trajectory_valid`。
>
> ❓ **Q27a — TaskRunner 的第一版实现**
>
> ➡️ 推荐 A：用 DSH coding-agent/工具环境运行小模型，用官方 SWE-bench evaluator 判分，并将两者封装成可替换 adapter。
> B：完整调用外部 `swebench`/mini-SWE-agent 工作流。
> C：自己写只生成 patch 的 runner。
>
> ❓ **Q28a — 数据配比能力**
>
> ➡️ 推荐 A：在固定输入轨迹池内支持按 bucket、source、能力标签加权，支持重复采样和目标配额，最终生成确定性的 `trajectory_train`。
> B：只支持筛选和排序。
> C：第一版就允许生成新的 rollout/合成轨迹。
>
> ❓ **Q29a — 是否现在预留质量评估 stage**
>
> ➡️ 推荐 A：现在定义可插拔的 `quality` stage，但第一版只运行便宜的确定性检查；质量不合格就跳过训练并归档证据。
> B：第一版就加入质量评估 agent。
> C：完全不预留这个 stage。

用户原答：

> Q20-1c：选A
>
> Q27b-1c:这个看看别人是怎么做的，会不会让generator联网，使用shell，下载依赖之类的，目前我回答不了这个问题
>
> Q27a：使用mini-SWE-agent吧，后续我可能会换别的harness
>
> Q28a：解释一下选项A
>
> Q29a：如果现在不预留的话，后面改动的时候能加回来吗？

当前归纳：

- `trajectory_train` 是第一版唯一的 SFT 训练视图；训练步数/epoch 固定，不启用 SFT 层的 `trajectory_valid`、eval 或 early stopping。这不影响未来为训练监控增加留出视图的接口。
- 第一版 TaskRunner 采用 `mini-SWE-agent`，但通过 `TaskRunner` 抽象保留替换其他 harness 的能力。TaskRunner 负责让小模型尝试任务；SWE-bench evaluator 负责评分，二者产生的完整轨迹和评分证据分别归档。
- Q27b-1c 未关闭。用户要求先调查 Generator 的联网、shell 和依赖安装惯例，不能把“使用 mini-SWE-agent”误读为 Generator 已获 shell 权限。

#### Q28a 中四个配比概念

这里的 `bucket` 是输入轨迹池内的分类，不是 benchmark 的 train/dev/test。例如可以按 `source`、工具调用能力、任务类型或长度把轨迹分为 `tool_use`、`coding`、`error_recovery` 等桶。一条轨迹是否只能进一个桶、标签怎样得到，仍属于后续策略契约。

`weight` 表示各桶在训练视图中的相对倾向。例如 A/B/C 三桶权重为 `0.5/0.3/0.2`，目标总量为 100 时，理想分配约为 50/30/20；权重本身不是硬性最小数量。

`repeat sampling` 表示同一条已存在的轨迹可以在训练视图中出现多次，用来补足稀有桶，不创造新的语义轨迹。例如某桶只有 10 条、目标需要 30 条，可以重复采样并给每个物理副本一个 occurrence 标识；代价是更容易过拟合，需保留可追溯的原始 ID。

`quota` 是硬约束或范围约束，例如 `tool_use` 至少 20 条、`error_recovery` 不超过 40 条。常见确定性流程是先满足可行的 min/max quota，再用 weight 填满剩余名额；如果配额互相冲突，策略应报告冲突并拒绝该视图，而不是静默超配。

一个闭集例子：输入池有 60 条 `coding`、30 条 `tool_use`、10 条 `error_recovery`，目标输出 100 条，配额为 `coding=40`、`tool_use=30`、`error_recovery=30`。Host 可从前两桶筛选/采样，从最后一桶重复采样到 30 条；输出仍只包含输入池中的轨迹，使用固定 seed 后可复现。与只做筛选/排序相比，这能处理能力分布不均；与生成新 rollout 相比，它不引入池外语义和额外采样成本，但会依赖标签质量并可能放大重复样本的过拟合。

#### Q29a 的可后加性

不预留也能后加，但不是零成本：需要改动 stage 编排、候选状态/评测 artifact schema、失败和跳过语义、配置迁移以及集成测试；已经保存的旧运行结果还要定义兼容读取规则。现在预留一个通用的可选 stage 边界并把它默认关闭，首版仍只执行便宜的确定性检查，后续即可注册代码质量检查或质量评估 agent，而不必重写训练和评测主流程。预留接口不等于现在引入第三个 agent。

#### Q27b-1c 调研结论

- Meta-Harness 的 proposer 常见工具组合是 `Read/Glob/Grep/Write/Edit/Bash`，候选在外层 sandbox 中执行；默认没有 WebSearch/WebFetch，Bash 能否联网取决于 sandbox 配置。
- CurateEvo 使用 GPT-5.4 配合 `mini-SWE-agent` 做代码演化，提示约束重依赖并要求 syntax check/dry-run；没有证据表明它默认允许任意外网或任意依赖安装。
- mini-SWE-agent 的原生动作是 Bash，Docker/Singularity/bubblewrap 等环境通常预构建依赖；这描述的是 TaskRunner/执行环境，不自动授予 Generator 宿主机权限。
- OpenEvolve 说明 proposer 也可以只返回源码、由 Host 负责执行，shell 不是必需条件。
- 目标 DSH rc.2 的 stock `standard`/`code` preset 带 shell 与文件搜索；`dsh-tool-fs` 本身提供读/写/编辑，搜索另由 `dsh-tool-fs-search` 提供。`tools.restrict()` 主要控制可见工具，不是完整的安全边界，真正的路径和进程限制要靠 sandbox/guard。进程内 child 会复用 Host 提供的 runtime/tool factory，但不会自动获得目标 workspace 的写权限。

工程含义：Generator 的权限应单独声明为 capability profile。可选方向是 (A) 仅文件工具、无 shell/网络/安装；(B) 隔离 workspace + sandbox shell，仅允许自检命令，网络关闭、依赖锁定/预构建；(C) 在受控缓存和 allowlist 下开放网络或安装。相关工作支持 B 或更严格的 A；无限制 C 不应作为第一版默认。此处仍等待用户选择，不能由调研替代决定。

状态：`accepted`（Q20-1c 选择 A；Q27a 选择 `mini-SWE-agent` 且 TaskRunner 可替换）+ `open`（本轮的 Q27b-1c、Q28a、Q29a）。Q27b-1c 与 Q29a 随后由 R10 继续收敛；Q28a 被拆成 R10a–R15 的子问题。

### R10 — Generator shell、网络和配比能力的进一步澄清

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7348`（JSONL line `7349`，`2026-09-03T11:13:14.442Z`）解释 Q28a/Q29a 并重问 Q27b-1c；user event ordinal `7354`（JSONL line `7355`，`2026-09-03T11:21:58.605Z`；`history.jsonl:3281`）作答；assistant event ordinal `7541`（JSONL line `7542`，`2026-09-03T11:31:49.742Z`）给出研究结论并提出下一轮选择。该 user 消息前缀为 3,281 行、454,682 bytes，SHA-256 `c7a6d1b16c9ac6194783a7b832f7e1a50114bd236b2cf9bce3437c8dd387d4a6`。

决定性问题与推荐原文（摘录）：

> ❓ **Q27b-1c — Generator 的 capability profile**
>
> ➡️ 推荐第一版选 A：只开放隔离 workspace 内的文件工具，不允许 shell、网络和安装依赖；锁定依赖由 Host 预构建。之后再增加 B 作为显式能力档案：允许 sandbox shell 做语法检查和 dry-run，但网络关闭、依赖不可变。C（允许受控网络或依赖缓存）留到后续。
>
> ❓ **Q28a — 数据配比能力**
>
> ➡️ 是否确认第一版采用 `bucket + weight + repeat sampling + quota`，仍保持闭集输入池？
>
> ❓ **Q29a — 质量 stage**
>
> ➡️ 是否确认现在预留通用 stage 接口，但第一版默认关闭，只执行确定性检查？

用户原答：

> Q27b-1c：感觉可以允许shell吧，这样的话child agent就可以自己去检查一下自己写的对不对吧还是你不推荐。此外，没法禁止网络读取那就不禁止了，感觉无所谓，防止增大工作量
>
> Q28a：repeat sampling 这个是不是不怎么好？别人会这样子做吗？以及你说的这几个数据配比能力是一开始就实现出来，还是后续自进化的时候模型自己就会实现出来
>
> Q29a：可以，先留一个

当前归纳：

- Generator 倾向允许 shell，目的是在隔离候选 workspace 内自行运行语法检查、单元测试或 dry-run。child 的检查结果只是辅助证据；Host 仍必须在冻结的完整 snapshot 上重新执行确定性检查、训练和 benchmark。
- 用户倾向不额外禁止网络读取。这里要明确：一旦直接开放出站网络，底层 shell 通常也无法可靠区分“只读”与上传；这是接受更宽环境边界的选择，不应描述成网络已被隔离。
- 早先已确认的“禁止新增未锁定的外部依赖”仍然有效，除非用户明确改写该决定。允许网络不等于允许 `npm/pip install` 或修改依赖锁；依赖安装规则仍是待确认的细节。
- Q29a 已确认预留可插拔 quality stage，首版默认关闭；不现在加入质量评估 agent。

#### Repeat sampling 的研究结论

在一般的 SFT/数据混合研究中，按比例上采样或用 sampling weight 平衡稀有数据是常见技术。SMART（[arXiv:2403.08370](https://arxiv.org/abs/2403.08370)）把任务混合权重作为显式优化对象，并与 proportional/equal mixing 比较；Dynamic Data Mixing（[arXiv:2406.11256](https://arxiv.org/abs/2406.11256)）也动态调整数据集采样权重。它们说明“重复出现已有样本”并非反常做法，但不等于每个系统都会把 JSONL 物理复制多份。

在已核对的 harness 自进化工作中，论文更常报告数据选择、混合权重或 held-out 反馈，较少明确写出对同一条完整轨迹做无限重复采样。因此不能说 harness 领域有统一的 repeat sampling 惯例。它的主要风险是小桶过拟合、重复错误被放大、有效样本数被高估；好处是能在闭集和固定总步数下提高稀有能力的曝光率。

#### 哪些能力现在实现，哪些交给自进化

建议分两层：

1. **框架能力（现在实现）**：提供稳定的策略原语和校验，例如 bucket/标签过滤、按权重分配、min/max/target quota、确定性 seed，以及可选的 repeat factor 上限。它们是引擎能力，不应等 Generator 每轮重新发明。
2. **策略取值（由自进化调整）**：Generator 修改各 bucket 的定义、权重、配额、过滤条件和是否启用 repeat；Host 负责 schema 校验、冲突检测、物化 `trajectory_train` 和记录统计。

这样既保留未知策略的探索空间，也不会让第一轮候选把时间花在重写基础采样器上。repeat 可以作为已实现但默认关闭的原语；只有候选明确启用且通过上限/去重/追踪检查时才生效。若只在后续让 Generator 自己实现这些能力，理论上可行，但每个候选都要承担更多代码风险，且难以公平比较。

#### 当轮状态（后续由 R10a–R13 修订）

- Q27b-1c：用户倾向“允许 shell、网络不额外禁止”，但 shell 的隔离方式、依赖安装是否允许、资源上限和完整命令范围仍需确认。DSH 的 stock `standard`/`code` preset 不能单独提供这个合同；应使用 capability profile、workspace 沙箱和 Host 的事后白名单检查。
- Q28a：本轮仍在讨论首版内置哪些配比原语；用户在下一条直接回答中选择 Q28a-1 的 A，见 R10a。
- Q29a：已接受“现在预留 quality stage、首版默认关闭”。

状态：`accepted`（Q29a）+ `needs-confirmation`（当时仅倾向允许 shell、网络不额外禁止，依赖边界和配比原语细节仍未确认）。Q27b-1d/Q28a-1 在 R10a 关闭；repeat 先由 R11 暂定默认关闭，再由 R13 改为首版完全取消。

## 历史前沿快照（R10 后，已被 R10a–R15 和文末当前决定索引取代）

### Q27b-1d — shell、网络与依赖的边界

用户已经表达允许 shell、且不额外禁止网络读取的倾向。还需要确认：shell 是否可执行任意自检命令（仍受 workspace/CPU/时间限制），以及是否继续保持“依赖锁定、禁止新增未锁定依赖”的既有决定。推荐保留依赖锁定；Generator 可以使用预构建依赖和网络读取，但不能让候选依赖一次性安装结果成为执行前提。

### Q28a-1 — 配比原语的首版范围

推荐现在在 core 中实现 bucket/过滤、weight、quota 和确定性 seed；repeat factor 也定义接口但默认关闭。Generator 负责提出这些原语的策略取值，不能把基础采样器从零重写。备选是首版只实现筛选/排序，后续再让候选代码增加采样能力。

### Q28a-2 — repeat 的表示方式

推荐保留原始轨迹唯一记录，以 `repeat_factor`/采样计划表达重复曝光；只有 trainer 确实需要物理 JSONL 行时才在导出阶段确定性展开，并保留原始 ID 和 occurrence。备选是完全禁止 repeat，或直接把重复行永久写入训练 artifact。

后续结果（见 R13）：第一版不需要 repeat；不实现重复曝光和对应的采样计划。

Q29a 已关闭：现在预留 quality stage，第一版默认不运行质量 agent。

### R10a — Q27b-1d 与 Q28a-1 的直接确认

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7541`（JSONL line `7542`，`2026-09-03T11:31:49.742Z`）提出 Q27b-1d/Q28a-1/Q28a-2；user event ordinal `7548`（JSONL line `7549`，`2026-09-03T11:41:17.431Z`；`history.jsonl:3282`）回答。

决定性问题与推荐原文：

> ❓ **Q27b-1d — 依赖和 shell 的最终边界**
>
> ➡️ 推荐 A：允许隔离 workspace 内执行 shell，网络开放，但只使用预构建和锁定依赖，不允许新增未锁定依赖。Host 继续做资源限制、白名单检查和 clean-run。
> B：允许安装新依赖，同时为每个候选保存完整环境镜像和 lockfile，成本明显更高。
>
> ❓ **Q28a-1 — 配比原语何时实现**
>
> ➡️ 推荐 A：第一版就在 core 中实现 bucket、weight、quota 和可选 repeat；repeat 默认关闭，Generator 只调整策略取值。
> B：第一版只实现筛选/排序，后续由 Generator 自己增加采样能力。
> C：第一版实现 bucket、weight、quota，但完全不提供 repeat。
>
> ❓ **Q28a-2 — repeat 如何落盘**
>
> ➡️ 推荐 A：保存 `repeat_factor`/采样计划，导出时按需展开。
> B：直接把重复后的 JSONL 永久写入训练 artifact。
> C：第一版完全禁止 repeat。

用户原答：

> Q27b-1d：选A
>
> Q28a-1：选A，并且repeat可以作为原子能力吧，如果大家都会进行重复曝光的话，不过我还有个问题，数据清洗数据配比这个部分，就只有这几个原子能力吗，后续自进化的时候大概能做成什么样子？以及这几个原子能力需要怎么进行实现
>
> Q28a-2：这个你推荐怎么实现

当前归纳：Q27b-1d 选择 A，即允许隔离 workspace 内的 shell 和开放网络，但候选仍只能使用预构建、已锁定依赖，不能新增未锁定依赖。Q28a-1 也明确选择 A：第一版由 Core 提供 bucket、filter、weight、quota 和确定性 seed 等基础配比原语，Generator 调整策略取值；其中“可选 repeat”随后被 Q28a-2/R13 明确取消，但不能因此把其余 Q28a-1 原语误写成未确认。

状态：`accepted`（Q27b-1d A；Q28a-1 A 的非 repeat 部分）+ `superseded`（Q28a-1 A 中曾包含的可选 repeat，由 R13 取消）。

### R11 — repeat 默认关闭

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7541`（JSONL line `7542`，`2026-09-03T11:31:49.742Z`）推荐把 repeat 作为默认关闭的可选原语；user event ordinal `7602`（JSONL line `7603`，`2026-09-03T11:42:51.012Z`；同一文本重复见 `history.jsonl:3283-3284`）接受“默认关闭”；assistant event ordinal `7607`（JSONL line `7608`，`2026-09-03T11:43:05.034Z`）复述当时语义。历史索引时间戳 `1788435770` 对应 `2026-09-03T11:42:50Z`；本条以 JSONL 原始 UTC 时间为准。重复消息只记录一次设计决定。

问题与推荐原文：

> **Q28a-1 — 配比原语何时实现**：推荐 A，第一版就在 core 中实现 bucket、weight、quota 和可选 repeat；repeat 默认关闭，Generator 只调整策略取值。

用户原答：

> 算了算了，repeat作为默认关闭吧

当前归纳：Q28a-1 的“首版提供配比原语”仍有效，但 Q28a-2 后续明确排除 repeat。第一版训练视图中每个 canonical `record_id` 最多出现一次；不实现 `repeat_factor`、`occurrence` 或重复采样计划。若未来重新引入 repeat，需要另行开启版本化能力并重新讨论落盘协议。

状态：当时为 `accepted`（repeat 可用但默认关闭）；现为 `superseded by R13`（首版完全不实现 repeat）。

### R12 — 配比原语范围与 repeat 落盘建议

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。user event ordinal `7548`（JSONL line `7549`，`2026-09-03T11:41:17.431Z`）询问原语范围和 repeat 实现；assistant event ordinal `7667`（JSONL line `7668`，`2026-09-03T11:46:53.378Z`）给出决定性解释、推荐并提出 Q28a-2/Q28a-3。本条是 assistant recommendation，不含独立的 user 确认；用户的后续回答记录在 R13。

用户触发问题原文：

> 数据清洗数据配比这个部分，就只有这几个原子能力吗，后续自进化的时候大概能做成什么样子？以及这几个原子能力需要怎么进行实现
>
> Q28a-2：这个你推荐怎么实现

助手推荐原文（摘录）：

> ❓ **Q28a-2 — 是否采用采样计划方案**
>
> ➡️ 我推荐：保留唯一 canonical record，用 `repeat_factor`/`occurrence` 表达重复，最后由 trainer adapter 按需展开。是否确认这个方案？
>
> ❓ **Q28a-3 — 第一版 bucket 如何产生**
>
> ➡️ 推荐先只使用确定性元数据，例如来源、工具名称、消息轮数、长度和已有字段；暂时不让 LLM 为每条轨迹生成标签。后续可以再增加质量模型或 Diagnosis 产生的标签。

本轮进一步解释了“原子能力”和“自进化策略”的边界。数据清洗/配比不只包含 bucket、weight、quota 和 repeat，还可以组合以下能力：结构校验与规范化、工具调用完整性检查、精确/近似去重、长度和轮数过滤、特征与标签抽取、按来源或能力分桶、排序/课程顺序、来源多样性约束、质量信号筛选，以及未来可选的 train/valid 划分。第一版仍保持闭集，不做池外 rollout；质量 agent 由已预留的 quality stage 承载，不提前加入。

建议采用两层演化模型：

1. **Core 原语（首版实现）**：以纯函数提供规范化、过滤、去重、bucket、weight、min/max/target quota 和确定性 seed。原语负责合法性、可复现性和统计，不负责决定研究策略；repeat 不在第一版原语集合中。
2. **策略取值（由 Generator 演化）**：Generator 修改 bucket 定义、过滤条件、权重、配额和顺序；Host 校验策略、物化训练视图并记录 lineage。未来候选可以在白名单目录内增加新的特征提取器或组合器，但不能绕过 Core 合同或修改 DSH/runtime/evaluator 等锁定边界。

推荐的纯逻辑流水线是：

```text
source adapter
  -> normalize / deterministic checks / quarantine
  -> deduplicate
  -> feature enrichment + bucket assignment
  -> filter and quota/weight allocation
  -> deterministic sampling (without repeat in v1)
  -> logical training-unit expansion
  -> ms-swift export adapter
```

第一版不实现 `repeat`，因此不生成 `occurrence` 或重复采样计划；每个 canonical record 在训练视图中最多出现一次。若未来重新引入它，仍建议保留唯一 canonical record，再由 trainer adapter 按需展开，以避免重复记录污染去重、ID 和审计逻辑。

当时的助手建议（未获确认）是先检查 min/max/target 是否可行，再满足硬配额，最后按归一化 weight 从唯一候选中填充剩余名额；如果唯一候选不足则报告配额不可行并拒绝该视图。R15 中用户明确表示“不刻意补足”，并要求先解释 quota，因此这一拒绝策略不能当作当前决定。

状态：`informational`（原语边界与实现建议）；其中 Q28a-1 的非 repeat 部分后续保持 `accepted`，repeat 落盘建议被 R13 `superseded`，Q28a-3 由 R13 接受。

### R13 — 取消 repeat 与确定性 bucket 标签

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7667`（JSONL line `7668`，`2026-09-03T11:46:53.378Z`）提出 Q28a-2/Q28a-3；user event ordinal `7673`（JSONL line `7674`，`2026-09-03T11:54:03.630Z`；`history.jsonl:3285`）回答；assistant event ordinal `7678`（JSONL line `7679`，`2026-09-03T11:54:27.755Z`）确认。该 user 消息前缀为 3,285 行、455,531 bytes，SHA-256 `de07e3fe2354bf2c23ec1d65c3fbc70047a209f52457d318ff8038e462ee6722`。

问题与推荐原文：

> ❓ **Q28a-2 — 是否采用采样计划方案**
>
> ➡️ 我推荐：保留唯一 canonical record，用 `repeat_factor`/`occurrence` 表达重复，最后由 trainer adapter 按需展开。是否确认这个方案？
>
> ❓ **Q28a-3 — 第一版 bucket 如何产生**
>
> ➡️ 推荐先只使用确定性元数据，例如来源、工具名称、消息轮数、长度和已有字段；暂时不让 LLM 为每条轨迹生成标签。后续可以再增加质量模型或 Diagnosis 产生的标签。

用户原答：

> Q28a-2：想了一下还是不需要repeat了，感觉很麻烦
>
> Q28a-3：同意

当前归纳：

- 第一版完全不做重复采样；`trajectory_train` 中同一个 canonical `record_id` 最多出现一次。此前“repeat 可选原子能力、默认关闭”的表述被本答覆盖；未来若要重新引入，必须作为新的版本化设计节点讨论。
- 第一版 bucket 只由确定性、可版本化的 canonical 内容特征生成，例如消息/assistant turn 数、工具调用存在性和长度区间；不调用 LLM 为每条轨迹打标签。Q28a-3 原问题中的“来源/source”示例后来被 R22 的最小、来源中立 v1 明确排除，不再作为 v1 facet。标签生成规则及版本写入训练视图 manifest，保证同一输入和 seed 得到相同结果。
- 配比原语首版仍包括过滤、bucket、weight、quota、排序和 deterministic seed。由于不重复，weight 只影响唯一候选的抽样/分配优先级；quota 超过可用唯一记录时，第一版应报告缺口，具体是拒绝还是带 warning 继续仍待确认，不能静默复制记录。

后续自进化仍可修改 bucket 规则、权重、配额和过滤组合；若未来要引入 LLM 标签或 repeat，需新增明确的能力开关、schema 版本和审计字段，不能由候选代码隐式改变语义。

状态：`accepted`（首版无 repeat；Q28a-3 的确定性 bucket 起点）+ `supersedes R11/R12`（repeat 可用但默认关闭、以及采样计划落盘建议）。

## 历史前沿快照（R13 后，已被 R14–R15 和文末当前决定索引取代）

### Q28a-4 — 不重复时 weight 的作用

没有 repeat 时，weight 不能增加某条轨迹的曝光次数；它只在训练视图有总量上限、需要从唯一候选中下采样时决定相对抽取概率/优先级。如果首版总是保留全部唯一记录，weight 只作为策略统计，不会改变训练数据。推荐首版明确一个可选的 `target_count`：有上限时按 weight 做无放回、带固定 seed 的选择；无上限时保留全部通过检查的唯一记录。

### Q28a-5 — quota 不可满足时的处理

由于第一版不重复，某个 bucket 的 min/target quota 可能超过其可用唯一记录。推荐把候选标为 `infeasible`，记录缺口和冲突，交给 Diagnosis/Generator 调整策略；不要静默降低 quota 或复制记录。是否允许“降级为 warning 并继续”仍待确认。

### Q28a-6 — 首版确定性 bucket 字段（历史提案，source 部分已被替代）

推荐只使用不依赖模型的字段：source、消息数、assistant turn 数、是否/多少工具调用、字符或 tokenizer 长度、结构校验结果，以及输入中明确存在的元数据。每个字段提取器和 bucket 规则都带版本；首版不使用 LLM 质量标签。多标签 bucket、近似长度和 outcome 标签可在后续扩展。

后续状态：R22 取消 v1 的来源明细和向 Agent 暴露来源信息，因此本段 `source` 例子不再进入 v1；消息/turn 数、工具调用、长度和结构校验等来源中立的确定性 facets 仍有效。

### R14 — `TrainingViewEntry`、quota 短缺与 bucket 用途

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7729`（JSONL line `7730`，`2026-09-03T11:57:38.348Z`）提出 Q28a-4/Q28a-5/Q28a-6 和 `TrainingViewEntry` 建议；user event ordinal `7735`（JSONL line `7736`，`2026-09-03T12:04:16.303Z`；`history.jsonl:3286`）回应；assistant event ordinal `7799`（JSONL line `7800`，`2026-09-03T12:08:58.359Z`）解释并提出 Q28a-7。该 user 消息前缀为 3,286 行、456,037 bytes，SHA-256 `1eff2caad170d66e59361d080f23989e7257658d11ee47f7c17d2e11de095ccc`。

问题与推荐原文：

> ❓ **Q28a-4 — weight 的实际作用**
>
> ➡️ 推荐首版提供可选 `target_count`：有总量上限时按 weight 无放回选择；没有上限时保留所有唯一记录。是否确认？
>
> ❓ **Q28a-5 — quota 不可满足时**
>
> ➡️ 推荐候选直接标记 `infeasible` 并进入下一轮，不自动降低 quota。是否确认？
>
> ❓ **Q28a-6 — 首版 bucket 字段**
>
> ➡️ 推荐使用 source、消息数、assistant turn 数、工具调用数量、长度和结构校验结果等确定性字段。是否确认这组字段作为第一版起点？

用户原答：

> 我的问题：即使不做 repeat，仍建议在唯一轨迹选择和 ms-swift 导出之间保留一层 TrainingViewEntry。为什么你推荐这个
>
> Q28a-4：如果大家都这样子做的话，那就确认
>
> Q28a-5：这个感觉还需要讨论一下，别人都是怎么做的，他们是选择宁缺毋滥吗，达不到目标数量也没事，就直接训吗
>
> Q28a-6：可以，不过这个bucket字段作用是什么

#### 为什么需要 `TrainingViewEntry`

它不是把完整轨迹再复制一份，而是一个轻量的、不可变的训练视图引用层：`CanonicalRecord` 保存唯一的清洗事实，`TrainingViewEntry` 保存本次策略对该记录的选择、bucket、排序、权重和 provenance，ms-swift adapter 再把 entry 转成具体 JSONL。这样不同候选可以复用同一输入快照而生成不同训练视图，Host 也能检查没有池外记录、重复 ID 或未记录的过滤结果；切换 trainer 时不必改 Core。它可以只是结构化对象数组，不需要重型类。

#### quota 短缺的相关实践

没有统一的行业规则：ms-swift 的 `dataset_sample`、LLaMA-Factory 的 replacement sampling、Open-Instruct 的目标 sample count 以及 Hugging Face 的 `all_exhausted` 都可能用 oversampling 填满预算；严格策展流程则会把最小数量视为硬约束并报告 infeasible。第一版已排除 repeat，因此建议区分 `target_count`（软目标，短缺时使用全部唯一记录并记录 warning）和 `min_quota`（硬要求，短缺时跳过候选训练并交给下一轮调整）。这只是推荐，Q28a-5 仍开放。

#### bucket 的作用

bucket 不是 benchmark 的 train/dev/test，也不是要求模型学习的标签，而是用于观察、控制和诊断的可解释分组。它能显示训练视图中普通对话、工具调用、长链路等类型各有多少条；配合 weight/quota/filter 可以只调整某一组；Diagnosis 还可以比较候选前后某个失败相关组是否被过度过滤。当轮曾建议把 `source=foo` 与工具调用、长度等作为独立 facets；R22 后来排除了 v1 的来源信息，因此当前只保留 `tool_profile=parallel`、`length_bin=long`、turn 数和结构校验等来源中立的确定性 facets，不拼成一个容易爆炸的单一 bucket 名称。

当轮状态：Q28a-6 已接受确定性字段方向；Q28a-4 的 weight/target_count 语义和 Q28a-5 的短缺处理仍待确认。`TrainingViewEntry` 当时仍只是实现建议；R15 随后明确接受了这一概念。

### R15 — 接受 `TrainingViewEntry`，并重开 weight/quota 的精确定义

来源：session `01a060d5-6a05-7573-9259-8e535905a19f`，文件 `/root/.codex/sessions/2026/09/02/rollout-2026-09-02T14-36-34-01a060d5-6a05-7573-9259-8e535905a19f.jsonl`。assistant event ordinal `7799`（JSONL line `7800`，`2026-09-03T12:08:58.359Z`）解释并提出 Q28a-7/Q28a-4/Q28a-5；user event ordinal `7805`（JSONL line `7806`，`2026-09-03T14:11:40.976Z`；`history.jsonl:3305`）回答。这是该 root session 中最后一条实质设计回答；其后的 user events `7811`、`7817`、`7823`、`7829`、`7835`、`7841`、`7847`、`7855`、`7861`、`7867` 均只是“继续”，不产生新决定。

问题与推荐原文：

> **Q28a-7 — 是否接受中间视图层**：推荐保留一个轻量的 `TrainingViewEntry`（或改名为 `TrainingSelection`），不复制完整消息，只保存 `record_id` 和本轮选择/配比元数据。是否确认这个概念？
>
> **Q28a-4 — weight 和 target_count**：推荐有 `target_count` 时按 weight 对唯一记录做无放回选择；没有总量上限时保留全部通过检查的记录。是否确认？
>
> **Q28a-5 — quota 短缺**：推荐软 `target_count` 不足时继续训练并记录 warning；硬 `min_quota` 不足时跳过候选并标记 infeasible。是否确认？

用户原答：

> Q28a-7：接受
>
> Q28a-4：感觉不需要刻意来补吧，筛选出来多少那就是多少，如果多了那就按照筛选出来的轨迹权重排序来取，我问一下weight是不是筛选清洗的时候给轨迹的权重？
>
> Q28a-5：这个感觉要讨论一下，首先告诉我 quota是什么

当前归纳：

- Q28a-7 已确认保留轻量 `TrainingViewEntry`：它引用唯一的 `CanonicalRecord`，记录本轮选择和配比元数据，不复制完整消息。
- Q28a-4 已确认“不为达到目标数量而补数据”；筛选结果少时按实际唯一记录训练，超过上限时再排序截取。用户所说的“轨迹权重”可能是单条轨迹的选择/质量分数，而前文 `weight` 指 bucket 级配比倾向，两者不能继续共用一个未定义术语。
- Q28a-5 仍未作选择。用户要求先解释 `quota`，因此前文关于 `min_quota` 不足即 `infeasible` 的建议没有被接受。

状态：当轮为 `accepted`（Q28a-7；不刻意补足）+ `clarified`（数据过量时排序截取）+ `open`（单条轨迹分数与 bucket weight 的术语/来源；quota 的含义、种类和短缺行为）；这些 open 项随后由 R16 明确关闭。

### R16 — 明确轨迹选择分数、bucket 权重与首版 quota

来源：session `01a067ca-7ae5-7de3-967c-13a7abb46b76`，文件 `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T23-01-58-01a067ca-7ae5-7de3-967c-13a7abb46b76.jsonl`。assistant event ordinal `825`（JSONL line `826`，`2026-09-03T18:34:10.647Z`）提出 Q28a-8 和重问 Q28a-5；user event ordinal `831`（JSONL line `832`，`2026-09-03T18:39:18.596Z`）回答。

决定性问题与推荐原文：

> **Q28a-8 — 轨迹分数与桶权重是否都保留？**
>
> - `selection_score`：属于单条 `TrainingViewEntry`，由本轮候选数据策略根据清洗后的事实计算；数据过多时用于排序截取。它不是写入不可变 `CanonicalRecord` 的清洗事实。
> - `bucket_weight`：属于整个 bucket，控制不同类型数据的总体配比，避免数量庞大的普通轨迹挤掉稀缺类型。
>
> 我建议首版保留两者，并禁止使用含糊的裸名称 `weight`。没有数量上限时，两者只记录统计，不改变训练视图。你是否确认？
>
> **Q28a-5 — quota 是什么，首版需要哪些？**
>
> 我建议首版只提供：
>
> - 可选的全局 `max_records`：训练视图最多多少条；
> - 可选的 bucket `max_quota`：限制某类数据不能占得过多；
> - 不提供硬 `min_quota`，也不要求填满目标；
> - 合格数据不足时全部使用并记录 warning，绝不复制或虚构数据。
>
> 是否确认这套 quota 语义？

用户原答：

> Q28a-8 :保留
>
> Q28a-5 — quota：认可

当前归纳：

- 首版同时保留 `selection_score` 与 `bucket_weight`，并禁止用裸 `weight` 混指二者。`selection_score` 是数据策略在构造本轮训练视图时生成、记录于单条 `TrainingViewEntry` 的排序值；它不是 canonical cleaning 阶段写入 `CanonicalRecord` 的不可变事实。`bucket_weight` 是 bucket 级的相对配比倾向，控制组间构成，不能充当单条轨迹质量分；没有选择上限时二者可以只形成统计而不改变视图。
- 首版 quota 只保留可选的全局 `max_records` 和可选的 bucket `max_quota`。前者限制整个训练视图最多包含多少条唯一记录，后者限制某个 bucket 最多占多少条；二者都是上限，不表达“必须凑满”。
- 首版不提供 `min_quota`，也不以 target count 要求补足。合格唯一记录不足时使用全部实际记录并产生 warning；不得重复、虚构或静默补入池外记录。合格记录过多时，先由 bucket 级配比约束构成，再以 `selection_score` 决定记录级优先顺序；精确冲突和 tie-break 规则留待稳定 ID 等后续节点确定。

状态：`accepted`（Q28a-8、Q28a-5）。

### R17 — no-repeat 只约束训练视图

来源：session `01a067ca-7ae5-7de3-967c-13a7abb46b76`，文件 `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T23-01-58-01a067ca-7ae5-7de3-967c-13a7abb46b76.jsonl`。assistant 首问 event ordinal `936`（JSONL line `937`，`2026-09-03T18:43:22.911Z`）；user 追问 event ordinal `942`（JSONL line `943`，`2026-09-03T18:54:10.447Z`）；assistant 调研解释并提出最终 Q28a-9a 的 event ordinal `1161`（JSONL line `1162`，`2026-09-03T19:03:28.898Z`）；user event ordinal `1167`（JSONL line `1168`，`2026-09-03T19:07:38.688Z`）选择 A。

初问的决定性选项与当时推荐原文：

> **Q28a-9 — 候选训练如何保证公平？**
>
> - A：固定完整 global packed batches，单 epoch、禁止 wrap；不足预算的候选仍训练供诊断，但标记 `under_budget`、不得晋升。
> - B：固定 optimizer steps，允许小数据集循环重复。
> - C：所有数据只训一遍且都能晋升，但各候选计算量不同。
>
> 推荐 A：最能保证候选比较公平，也与“不 repeat”一致。具体 batch 数和 token 容差稍后根据模型与 GPU 配置确定。是否确认？

用户追问：

> Q28a-9：别人是怎么做的，关于这个训练公平的事

公开实践核对表明：DCLM 固定模型、训练 recipe 和 train-token budget，并允许重复文档或通过 multiple data passes 补足预算；FineWeb 消融固定 token 数和 steps，并使用两个不同子集和初始化 seed；DoReMi 按处理 token 数等量计算、固定 steps 并重采样。普通 SFT 则常固定 epoch，例如 Alpaca 使用 3/5 epochs、LIMA 使用 15 epochs，但这类配方不是严格的数据策略公平榜。Successive Halving/Hyperband 只在相同 resource rung 内比较候选。

外部依据：DCLM 论文 <https://arxiv.org/abs/2406.11794>、DCLM 官方训练说明 <https://github.com/mlfoundations/dclm#4-model-training>、OpenLM `multiple-data-passes` 定义 <https://github.com/mlfoundations/open_lm/blob/main/open_lm/params.py>、FineWeb 论文 <https://arxiv.org/abs/2406.17557>、DoReMi 论文 <https://arxiv.org/abs/2305.10429>、Stanford Alpaca 配方 <https://github.com/tatsu-lab/stanford_alpaca#fine-tuning>、LIMA 论文 <https://arxiv.org/abs/2305.11206>、Hyperband 论文 <https://arxiv.org/abs/1603.06560>。

调研后的决定性问题与推荐原文：

> **Q28a-9a — no-repeat 的边界**
>
> - A：只禁止视图重复；Trainer 可以整体现有视图循环多个 epoch，以达到统一训练预算。
> - B：连训练曝光也禁止重复；只能单 epoch/no-wrap，数据不足者不能参与同预算晋升。
>
> 推荐 A。它符合主流固定计算预算的方法，同时不需要在数据策略里实现复杂的逐轨迹 repeat。之后再讨论最大 epoch 安全阈值。你选择 A 还是 B？

用户原答：

> 选A

当前归纳：训练视图重复是同一 `record_id` 产生多个 `TrainingViewEntry`；训练曝光重复是 Trainer 在后续 epoch 再次读取同一唯一 entry。用户选择 A，只禁止前者；候选数据策略不能产生重复 entry 或逐记录 repeat factor。问句中“为达到统一训练预算”的理由后来被 R18 的固定 epochs、非等算力协议替代，但 no-repeat 的边界仍有效。

状态：`accepted`（Q28a-9a 的 no-repeat 边界）+ `superseded`（统一训练预算的理由由 R18 替代）。

## 当前设计摘要（汇总至 R28）

本摘要汇总截至 R28 的当前有效决定；R18–R28 的逐轮证据紧随其后，R19–R28 的精确状态索引位于文末。此前截至根 session `ordinal 7805` / `history.jsonl:3305` 的状态与飞书 revision `304` 一致；revision `303` 的运行事实仍保留，但不再决定后续执行顺序。上文较早的“当前状态”“当前前沿”均为历史快照。

### 已关闭的第一版决定

- 活跃产品和唯一实现仓库是 AutoData（`/root/autodata`）；`DataHarness` 只作历史名称或 DSH profile 语境。
- AutoData 是安装到 DSH 的单一 Bundle；DSH 保持运行时边界。Diagnosis Agent 与 Generator Agent 是两个逻辑角色，不设 Strategy Agent。
- Host 独占结果分类、重试与晋升控制权。candidate 问题和正常未晋升只在下一 round 由 Diagnosis 分析、Generator 产生新 candidate；冻结后不做同轮 repair。每个外部作业的明确基础设施故障最多原样重试一次，未知远端状态先对账，重试耗尽则停止 run 且 champion 不变。
- 输入为标准 ms-swift JSONL；坏行跳过；嵌套 sub-agent 只读主轨迹；`developer` 暂时保留。第一版只做闭集策展。
- Host 从 champion snapshot 创建隔离 workspace，Generator 在白名单内编辑；完整 `CandidateSnapshot` 是执行/回滚真相，diff 是派生审计附件，不保留 `operations[]` fallback。
- Q10 已选择自动晋升形状；第一版保留 best-so-far champion 和 immutable archive。晋升主指标是完整 search split 上的 `resolved_count`；candidate 至少多解决一题才晋升，平分或下降均保留 incumbent，不设逐 case regression guardrail。v1 不做 baseline 重跑或多 seed 稳定性验证，并把随机波动记为实验限制。
- 首个 benchmark 是 SWE-bench Full；Full dev 用于反复 search，Full test 密封；首版无独立 promotion validation。ADR-0001 已被 ADR-0002 替代。
- 首版只生成 `trajectory_train`，不启用 `trajectory_valid`；TaskRunner 默认 `mini-SWE-agent` 且保持可替换；quality stage 只预留接口、默认关闭。
- 第一版 Core 提供 filter、bucket、`selection_score`、`bucket_weight`、`max_records`、bucket `max_quota` 和确定性 seed 等配比原语；bucket 只来自来源中立、可版本化的 canonical 内容特征；不实现 repeat，同一个 canonical `record_id` 在训练视图中最多出现一次。
- `TrainingViewEntry` 已接受为轻量引用层；不复制完整轨迹。`selection_score` 属于该 entry 而非 canonical cleaning 事实；`bucket_weight` 只表达组间配比倾向。
- 首版不提供 `min_quota`，也不要求把训练视图凑到目标数量。唯一记录不足时全部使用并告警；过量时受 `max_records`、bucket `max_quota` 和 `selection_score` 控制。
- no-repeat 只约束训练视图唯一性，不禁止 Trainer 在多个 epoch 中重新曝光该唯一视图。跨 epoch 的整体循环属于受 Host 控制的训练预算行为，候选数据策略仍不能指定逐记录 repeat factor。
- 首版训练协议采用一个由 Host 冻结的轨迹数量上限和固定 epoch 超参数：Generator 在上限内决定实际选择多少条唯一轨迹，默认 `epochs=2`。首版不以 token/steps 统一计算量，也不声称候选是等算力比较；实际 records、tokens、steps 和 epochs 必须记录。未来若改用统一训练资源，需要启用新的 protocol version 并在新协议下重建 baseline。
- `record_id` 采用 AutoData 自算、来源中立的版本化内容哈希；哈希材料是规范化后的 canonical 主轨迹内容，不编码上游系统名、路径或上游 ID。已确认内容边界以 `messages + tools` 为核心，但 canonical 到 trainer-facing 的精确投影仍在当前 frontier。
- 无法规范化为 canonical trajectory 的物理输入行称为 `Rejected input row`，在导入/规范化阶段跳过并留下最小定位证据；它不同于被数据策略排除的 `filtered-out record`。
- ADR-0003 已接受从活动实现移除 BFCL 专属内容，同时保留历史 Git、研究台账和运行产物证据。

### R18 — 固定轨迹数量方案的讨论与最终确认

来源：session `01a06a1b-7043-7703-8eba-1ab422940c59`，文件 `/root/.codex/sessions/2026/09/04/rollout-2026-09-04T09-49-38-01a06a1b-7043-7703-8eba-1ab422940c59.jsonl`。本轮不是一次提问后直接选择，而是用户连续追问并明确纠正过助手的误记；关键事件如下：

- user event ordinal `262`（JSONL line `263`，`2026-09-04T02:51:15.490Z`）追问训练资源与归因；assistant event `271`（line `272`，`2026-09-04T02:51:46.261Z`）提出 fixed tokens / fixed epochs / 双层协议。
- user event `277`（line `278`，`2026-09-04T03:02:10.003Z`）追问以后能否从 fixed epochs 切换；assistant event `282`（line `283`，`2026-09-04T03:02:35.233Z`）建议首版 fixed epochs、以后升级 protocol 并重建 baseline。
- user event `288`（line `289`，`2026-09-04T05:33:52.254Z`）提出固定轨迹数量更简单；assistant event `327`（line `328`，`2026-09-04T05:35:21.766Z`）给出 `max_records + fixed_epochs` 等选项。
- user correction event `411`（line `412`，`2026-09-04T05:38:22.797Z`）明确否认“继续”等于接受 A；assistant event `449`（line `450`，`2026-09-04T05:39:55.115Z`）改问 `max_records + max_optimizer_steps`、`max_records + fixed_epochs` 或统一 token 预算。
- user events `455`、`466`、`477`（lines `456`、`467`、`478`）继续追问 steps、epoch 与算力；对应 assistant explanations 为 events `460`、`471`、`482`（lines `461`、`472`、`483`）。
- user event `488`（line `489`，`2026-09-04T05:53:45.471Z`）给出最终决定；assistant event `514`（line `515`，`2026-09-04T05:54:58.139Z`）提出 Q28a-11；user event `520`（line `521`，`2026-09-04T06:20:40.412Z`）确认。

#### Q28a-10 — 首版训练比较协议

本轮先后讨论了 fixed token budget、fixed optimizer steps 和 fixed epochs。关键区别是：固定 epochs 实现最简单，但 Generator 可以通过选择不同数量、不同长度的轨迹间接改变实际 tokens 和 optimizer steps，因此这种协议比较的是“整套数据策略最终训练效果”，不能声称是等算力的数据效率实验。

assistant event `327` 当时给出的选项与推荐原文：

> A：固定 `max_records` + 固定 epochs；不足不补，记录实际 tokens/steps。以后切换固定 token 预算时，升级 protocol version 并重建 baseline。
>
> B：必须正好 N 条，不足则候选不得晋升。这会推翻此前“不足仍使用”的决定。
>
> C：现在就固定 token 预算。
>
> 基于你优先打通闭环的目标，我推荐 A。是否确认？

用户没有确认该推荐；在中间出现若干“继续”后，用户专门纠正：

> 关于你说的：• 我把你的“继续”理解为：接受推荐的 A（固定 max_records + 固定 epochs；不足不补；记录实际 tokens/steps），并进入下一题。如果这个
>   理解不对，你随时纠正，我会回退记录。这个我还没确定一定选A，继续聊一下

assistant event `449` 随后给出的最终一组选项与推荐原文：

> A：`max_records + max_optimizer_steps`，以后再升级成精确 token 预算。
> B：`max_records + fixed_epochs`，接受候选训练资源可能不同。
> C：现在直接实现统一 token 预算。
>
> 我推荐 A。

用户在解释 steps、epoch 与算力后没有选择推荐 A，而是给出自己的最终决定：

> 算了算了，就有一个轨迹上限数量，不能超过这些，然后再范围内，模型自己选择要训多少条，epoch固定一个超参数吧，暂时设置为2，轨迹数量上限也是一个超参数，这样子更简单，后面要改再改

当前归纳：首版只设一个由 Host 冻结的轨迹数量上限；Generator 可在上限内决定实际使用多少条唯一轨迹；`epochs` 也是 Host 冻结的超参数，首版默认 `2`。`max_records` 的具体数值仍待确定。候选的实际 records、input tokens、optimizer steps 和 epochs 都要记录，但首版不统一 tokens/steps，也不声称等算力。未来更换训练资源协议时必须升级 protocol version、重建 baseline/champion；新旧协议分数不得直接用于同一晋升比较。

状态：`accepted`。重复的“继续”和用户的问题都不是确认；只有 event `488` 的最终原答关闭了 Q28a-10。

#### Q28a-11 — 空训练视图

来源：session `01a06a1b-7043-7703-8eba-1ab422940c59`，文件 `/root/.codex/sessions/2026/09/04/rollout-2026-09-04T09-49-38-01a06a1b-7043-7703-8eba-1ab422940c59.jsonl`；assistant event ordinal `514`（JSONL line `515`，`2026-09-04T05:54:58.139Z`）提问；user event ordinal `520`（JSONL line `521`，`2026-09-04T06:20:40.412Z`）确认。

问题与推荐原文：

> **Q28a-11 — Generator 选择零条轨迹怎么办？**
>
> - 选择 0 条，或导出后没有任何可训练 assistant target：候选在训练前判为 `invalid`；
> - 不启动 GPU 训练；
> - 保存失败原因，供下一轮 Diagnosis 使用；
> - 这只是“非空可训练”的技术门槛，不是要求凑满某个最小数量。
>
> 推荐确认该规则。

用户原答：

> 确认

当前归纳：若训练视图为空，或导出后没有任何可训练 assistant target，候选在训练前判为 `invalid`，不启动 GPU 训练，并保存失败原因和统计供下一轮 Diagnosis 使用；这不引入 `min_quota`，也不要求补足数据。

状态：`accepted`。

以下 R19–Q38 均来自 session `01a0721f-39cf-72b3-b029-c8c8a9c5ff47`，原始文件 `/root/.codex/sessions/2026/09/05/rollout-2026-09-05T23-10-44-01a0721f-39cf-72b3-b029-c8c8a9c5ff47.jsonl`。每个条目的“来源”行都继承这里的完整 session ID 和文件路径；其中 ordinal 是从 `0` 开始的 JSONL event ordinal，并同时给出从 `1` 开始的物理行号和原始 UTC 时间戳，避免“2026-09-06 的续接会话”这类无法精确定位的描述。

### R19 — 来源中立 Record ID 与入口拒绝术语

来源：assistant event ordinal `808`（JSONL line `809`，`2026-09-05T15:57:27.577Z`）；user event ordinal `848`（JSONL line `849`，`2026-09-05T16:15:14.154Z`）。

问题原文：

> **Q30a-1 — Record ID**
>
> A. `ad:v1:<sha256>`，只哈希规范化后的 `messages + tools`
> B. 随机 UUID
> C. 上游 ID/文件行号
>
> **Q30a-3 — 无效输入**
>
> A. 改称 `Rejected input row`：在导入/规范化阶段跳过，并记录行号、原始行哈希和原因码
> B. 保留 `quarantine`
> C. 只计数，不留逐行证据

推荐原文：

> Q30a-1 推荐 A：最简单、稳定且不暴露上游系统。
>
> Q30a-3 推荐 A。它早于清洗和配比；有效但未选中的数据叫 `filtered-out`。

用户原答：

> 全按推荐

当前归纳：

- `record_id` 采用 AutoData 自算的版本化内容哈希 `ad:v1:<sha256>`；哈希材料只来自规范化主轨迹的训练内容 `messages + tools`，不使用上游 ID。
- 无法解析或不满足入口 schema、因而不能构造 `CanonicalRecord` 的物理行称为 `Rejected input row`；它在导入/规范化阶段逐行跳过并留存问题所列证据。
- 有效但后来未被策略选入训练视图的记录称为 `filtered-out record`，不得与 `Rejected input row` 混为一类。
- canonical serialization、tool-call linkage 规范化与版本升级属于待写的实现合同，不是本轮额外确认的用户选项。

状态：`accepted`（Q30a-1、Q30a-3）。

### R20 — 重复 input occurrence 的来源证据（历史方案）

来源：assistant event ordinal `959`（JSONL line `960`，`2026-09-05T16:21:04.204Z`）；user event ordinal `965`（JSONL line `966`，`2026-09-05T16:44:02.581Z`）。

问题原文：

> **Q30a-2 — 重复来源证据保留多少？**
>
> 实测 5,071 行中有 2,151 行是跨批重复，最终只有 2,920 条不同内容。内容相同只形成一个 `CanonicalRecord`；现在需决定重复来源如何留痕：
>
> A. 独立保存每次出现的匿名 shard 引用、行号和原始行哈希
> B. 只保存出现次数
> C. 只保存第一次出现

推荐原文：

> 推荐 A：不重复训练，同时完整可追溯，也不暴露上游系统。

用户原答：

> 选A并且跟我讲讲为什么需要这个

当轮归纳：相同内容只形成一个 canonical record，但为每次重复出现保存轻量来源明细。该方案在当轮被接受。

当前状态：`superseded by R22`。R22 后，v1 不保存逐 occurrence 明细；同条 assistant 消息中的哈希完整性处理也不是单独供用户选择的条款，不从本回答继续外推。

### R21 — Snapshot-scoped、Host-only Record provenance（历史方案）

来源：assistant event ordinal `1027`（JSONL line `1028`，`2026-09-05T16:46:21.787Z`）；user event ordinal `1033`（JSONL line `1034`，`2026-09-05T16:48:53.473Z`）。

问题原文：

> **Q30a-2b — Provenance 的时间范围**
>
> A. 每个 `InputSnapshot` 保存自己的不可变 occurrence map；跨 snapshot 查询使用派生索引
> B. 维护一份不断增长的全局 provenance
>
> **Q30a-2c — Provenance 的可见范围**
>
> A. 完整来源定位信息仅 Host 可见；Generator、DataPlugin 和 Trainer 只看到 Record ID、规范内容及明确批准的安全 facets
> B. 向 Generator/DataPlugin 暴露匿名来源引用和哈希
> C. 将 provenance 放进 CanonicalRecord 或训练 JSON

推荐原文：

> Q30a-2b 推荐 A：后来导入的数据不会改变过去实验的证据。
>
> Q30a-2c 推荐 A：保留审计能力，同时确保上游信息不会泄露。

用户原答：

> 全按推荐

当轮归纳：每个输入快照保留不可变 occurrence map，完整 locator 仅 Host 可见。该方案在当轮被接受。

当前状态：`superseded by R22`。上述 occurrence map、全局/跨 snapshot provenance 和 Host-only locator 均不进入 v1。

### R22 — 将输入身份与去重收窄为最小 v1

来源：user 追问 event ordinal `1075`（JSONL line `1076`，`2026-09-05T16:51:47.437Z`）；assistant 决定性问题 event ordinal `1107`（JSONL line `1108`，`2026-09-05T16:53:05.761Z`）；user 确认 event ordinal `1113`（JSONL line `1114`，`2026-09-05T16:54:05.328Z`）。

用户触发本轮简化的原话：

> 有点没怎么懂，怎么感觉聊了这么多越来越复杂了，本质上就是我这里提供了一批轨迹，然后每次读轨迹呗，为什么要搞这么多兜底什么哈希之类的

问题原文：

> 首版无需：
>
> - 全局 provenance 系统
> - 跨 snapshot 来源注册表
> - 上游 ID 冲突处理
> - 向 Agent 暴露来源信息
>
> **Q30-revision — 是否进一步简化**：是否确认首版只用内部内容哈希做 ID 和精确去重，仅记录重复数量与首次位置，取消刚才选择的“保存每次 occurrence 明细”？

推荐原文：

> 我现在推荐确认这个简化版本。

用户原答：

> 确认

当前归纳：

- v1 每次读取调用方提供的一批标准 JSONL：逐行解析、坏行按 R19 跳过、精确内容去重，再进入清洗和配比。
- Host 对规范化后的 canonical 主轨迹内容计算内部版本化内容哈希；它同时作为 `record_id` 和精确去重键，不依赖上游 ID，也不需要额外注册表。`messages + tools` 是已确认的核心内容边界，但 canonical JSON 编码以及 canonical 到 trainer-facing 的精确投影属于后续实现合同，不能由“哈希材料”反向冻结。
- 相同内容只保留一个 canonical record；只记录重复总数和首次物理位置，不保存 occurrence 明细、全局 provenance 或跨 snapshot 来源关系。
- 只做规范 JSON 完全相同的精确去重，不做模糊或语义相似去重。canonical JSON 的精确编码属于实现合同。

状态：`accepted`。R20、R21 被本轮明确取代。

### R23 — 晋升主指标采用 resolved count

来源：assistant 最终解释与重问 event ordinal `1159`（JSONL line `1160`，`2026-09-05T16:58:51.062Z`）；user event ordinal `1165`（JSONL line `1166`，`2026-09-05T17:11:23.885Z`）。此前 user event ordinal `1150` 明确要求详细解释，未被当作回答。

问题原文：

> **Q31 — 晋升主指标**：第一版是否只把固定 dev 集上的“解决任务总数”作为晋升主成绩？

推荐原文：

> 我推荐确认。

同一条解释明确：两者必须完整跑完同一批任务；分类、成本和时延只作诊断，不参与排名；本问题不决定晋升阈值、随机波动和逐题退化规则。

用户原答：

> 确认

当前归纳：

- 第一版只用冻结 SWE-bench Full search/dev case manifest 上的 `resolved_count` 作为晋升主成绩；`resolved_rate` 只是相同分母下的派生展示值。
- candidate 与 champion 必须覆盖同一完整 manifest 才可比较；缺少确定结果时本次评测无结论（实现状态名可暂称 `inconclusive`），不能用不完整分数晋升。
- 阈值和平分规则后来由 R25 关闭；随机稳定性由 R24 延后；逐 case guardrail 由 R26 关闭。

状态：`accepted`（Q31）。

### R24 — v1 延后随机稳定性验证

来源：assistant 详细重问 event ordinal `1238`（JSONL line `1239`，`2026-09-05T17:16:57.888Z`）；user 完整回答 event ordinal `1251`（JSONL line `1252`，`2026-09-05T17:22:51.749Z`）。user event ordinal `1244` 是被下一条完整消息覆盖的不完整版本。

问题原文：

> **Q32**：是否确认首版每个 candidate 只训练和评测一次，但开启自动晋升前，必须先用同一个 baseline checkpoint 重跑两次验证评测稳定性？

推荐原文：

> 推荐确认。

用户原答：

> ，必须先用同一个 baseline checkpoint 重跑两次验证
> 评测稳定性？ 这个先不管吧，作为一个记录点记录一下，这个可能会影响到后面的实验，当前先不考虑，不然太麻烦了，当前还是想完全重构一下并且完整跑通，就像我之前说的那样子跑通

当前归纳：

- 用户没有接受“先重跑 baseline 两次”这个前置门槛；v1 先按单次训练、单次完整评测跑通闭环。
- 单次结果可能受训练或评测随机性影响，必须作为实验限制记录；v1 结果不宣称稳定提升或统计显著性。
- 正式实验、观察到重跑不一致或需要对外主张稳定提升时，应重新打开多 seed/重复评测协议。

状态：`accepted`（v1 不以重复稳定性验证为前置门槛）；`deferred`（随机稳定性验证）。原推荐本身没有被接受。

### R25 — 晋升阈值与平分规则

来源：assistant event ordinal `1280`（JSONL line `1281`，`2026-09-05T17:23:41.449Z`）；user event ordinal `1286`（JSONL line `1287`，`2026-09-05T17:24:04.779Z`）。

问题原文：

> **Q33 — 晋升阈值和平分**：若 champion 解决 40 题，candidate 解决 41 题就晋升；仍是 40 题则保留 champion；低于 40 题则归档 candidate。是否确认采用这条最简单规则？

推荐原文：

> 推荐确认。逐题能力退化问题下一轮单独讨论。

用户原答：

> 确定

当前归纳：

- 只有 `candidate.resolved_count > champion.resolved_count` 才晋升；整数语义等价于至少多解决一题，不另设 `min_delta`。
- 平分或下降均保留 incumbent champion，candidate 作为 `not_promoted` 归档；不使用成本、时延或分类分数作隐藏 tie-break。
- 本轮暂未决定的逐题退化问题后来由 R26 关闭。

状态：`accepted`（Q33）。

### R26 — v1 不设逐 case regression guardrail

来源：assistant event ordinal `1322`（JSONL line `1323`，`2026-09-05T17:25:29.193Z`）；user event ordinal `1328`（JSONL line `1329`，`2026-09-05T17:25:55.481Z`）。

问题原文：

> **Q34 — 逐题退化保护**：是否确认 v1 仍只看总解决数，不因丢失旧题而否决晋升；但记录 `gained/lost/unchanged` 明细供 Diagnosis 查看？

推荐原文：

> 推荐确认，先保持闭环简单。否则还需设计“最多允许丢几题、哪些题不能丢”等额外规则。

用户原答：

> 确认

当前归纳：

- v1 即使丢失部分 champion 已解决的 case，只要总 `resolved_count` 严格增加，仍按 R25 晋升。
- Host 记录逐 case 的 `gained / lost / unchanged` 供 Diagnosis 分析，但不把它变成隐藏否决条件。
- 未来若要增加 regression guardrail，需要重新打开这一设计节点；是否必须升级 protocol version 尚未由本轮决定。

状态：`accepted`（Q34，scope=v1）。

### R27 — Host 分类，下一轮 Diagnosis → Generator

来源：assistant Q35 初问 event ordinal `1368`（JSONL line `1369`，`2026-09-05T17:27:45.326Z`）；user 要求解释 event ordinal `1374`（JSONL line `1375`，`2026-09-05T17:28:22.457Z`）；assistant 详细解释与重问 event ordinal `1387`（JSONL line `1388`，`2026-09-05T17:28:49.866Z`）；user 职责追问 event ordinal `1393`（JSONL line `1394`，`2026-09-05T17:30:29.173Z`）；assistant 决定性合并问题 event ordinal `1410`（JSONL line `1411`，`2026-09-05T17:31:10.918Z`）；user 确认 event ordinal `1416`（JSONL line `1417`，`2026-09-05T17:33:24.660Z`）。

Q35 前置问题原文：

> **Q35 — 最小失败分类**：是否确认 v1 只按处理方式区分：
>
> - `invalid`：候选自身有问题，例如代码不合法或训练数据为空；归档后进入下一轮。
> - `not_promoted`：完整跑完但分数没有提高；这是正常实验结果，不叫失败。
> - `infrastructure_failure`：GPU、节点、调度或网络等外部问题；不评价候选，尝试原样重试。
> - 坏输入行仍在导入阶段跳过，不属于候选失败。
>
> SWE-bench 中模型补丁错误或测试不通过，只算该题 `unresolved`。

用户追问原文：

> ok这几个方向我看懂了，那出现这几个问题的话，是诊断agent来看然后让generator来改还是什么

问题原文：

> **Q35/Q36 — 是否确认这套职责与流程**：Host 分类并控制流程；候选问题或未提升由下一轮 Diagnosis 分析、Generator 生成新 candidate；基础设施问题只原样重试；正式提交后不做同轮 repair？

推荐原文：

> 推荐确认。

用户原答：

> 确认

当前归纳：

- Host 依据确定性检查和外部作业证据分类结果，并独占重试、归档和晋升控制权；Diagnosis/Generator 不自行决定重试或晋升。
- candidate 自身无效或完整评测后未提升时，Host 归档证据并结束该 round；若还有后续 round，新的 Diagnosis 分析证据，新的 Generator 从当前 champion 生成新 candidate。
- 明确的基础设施故障由 Host 对相同冻结 candidate 和配置原样重试，不调用 Diagnosis/Generator 改内容；重试预算由 R28 关闭。
- Generator 提交并被 Host 冻结后不做同轮 repair；内容修改属于下一 round 的新 candidate。
- 输入坏行在 evolution round 前处理；SWE-bench 单题补丁失败只是该题 `unresolved`。

状态：`accepted`（Q35/Q36）。

### R28 — 基础设施原样重试一次

来源：assistant event ordinal `1443`（JSONL line `1444`，`2026-09-05T17:34:19.945Z`）；user event ordinal `1449`（JSONL line `1450`，`2026-09-05T17:34:44.793Z`）。

问题原文：

> **Q37 — 基础设施重试**：训练或评测若因 GPU、节点、网络等基础设施问题失败，Host 使用完全相同的 candidate 和配置自动重试一次；若作业状态不明确，先查询原作业，禁止直接重复提交；再次失败则停止本次 run，champion 不变。是否确认？

推荐原文：

> 推荐确认，简单且能避免无限重试和重复训练。

用户原答：

> 确认

当前归纳：

- 每个外部训练或评测作业遇到有明确证据的基础设施故障时，Host 最多原样重试一次，即最多两次尝试。
- 重试复用同一冻结 candidate 和配置，不调用 Diagnosis/Generator 改变实验内容。
- 作业状态不明确时先查询、对账原作业，禁止盲目重复提交；具体 job ID 和幂等机制属于实现合同。
- 第二次仍因基础设施失败时停止整个 run，保留 incumbent champion；不把它误记为 candidate `invalid`、`not_promoted` 或某个 benchmark case 的 `unresolved`。

状态：`accepted`（Q37）。

### Q38 — 首版运行几轮（尚未回答）

来源：assistant event ordinal `1474`（JSONL line `1475`，`2026-09-05T17:35:48.749Z`）。紧接着的 user event ordinal `1480`（JSONL line `1481`，`2026-09-05T17:37:41.586Z`）质疑本文档的记录方式，没有回答 Q38。

问题原文：

> **Q38 — 首版运行几轮**：一次 evolution round 指：
>
> `Diagnosis → Generator → 新 candidate → 训练 → 评测 → 晋升判断`
>
> baseline/H₀ 的准备与评测不计入 round。
>
> 是否确认 `max_rounds` 默认设为 `1`，即首版先完整跑通一个新 candidate？Host 一旦开始该轮 Diagnosis 就算消耗这一轮；candidate 无效或未晋升也算，基础设施原样重试不增加轮数。

推荐原文：

> 推荐确认。以后只需调大 `max_rounds`，无需修改流程。

用户原答：尚未回答。用户转而指出“只写续接会话和 Q37、却不保存问题原文”无法让另一位 Codex 理解决策；该反馈触发了本轮文档修正，不能当作 Q38 的确认。

状态：`open`。

## R19–R28/Q38 决定索引（截至 R28）

| 主题 | 当前记录 | 状态 | 当前规则 |
|-|-|-|-|
| 入口命名与来源中立 ID | R19、R22 | `accepted` | 逐行读 JSONL；坏行跳过；内部内容哈希同时作 ID 与精确去重键 |
| occurrence/provenance 明细 | R20、R21 → R22 | `superseded` | v1 不保存逐 occurrence、全局或跨 snapshot provenance |
| 晋升主指标 | R23 | `accepted` | 完整且相同 manifest 上比较 `resolved_count` |
| 随机稳定性 | R24 | v1 `accepted`；验证 `deferred` | v1 不以 baseline 重跑为前置门槛，并明确记录单次结果限制 |
| 阈值和平分 | R25 | `accepted` | 只在 resolved count 严格增加时晋升；平分/下降保留 incumbent |
| 逐 case regression | R26 | `accepted`（v1） | 记录 gained/lost/unchanged，但不作否决条件 |
| 失败处理与 Agent 职责 | R27 | `accepted` | Host 控制；Diagnosis/Generator 在下一轮处理候选问题；冻结后无同轮 repair |
| 基础设施重试 | R28 | `accepted` | 相同作业内容最多原样重试一次；再失败停止 run，champion 不变 |
| evolution round 数量 | Q38 | `open` | 尚未确认默认值和计数语义 |

## 当前 frontier

下一项必须先问的设计问题仍是 **Q38**。它只决定首版 `max_rounds` 默认值与计数语义；用户“先完整打通一个新 candidate”的目标不是对此题的自动确认。Q38 在用户明确回答前不得记为 `accepted`。

### 仍需用户决定的设计问题

1. **最终 sealed test 的调用与报告协议**：Full test 在何种明确事件后运行、是否必须由人触发、失败能否重试，以及结果如何标明“最终报告而非晋升证据”。
2. **输入投影边界**：顶层本身就是 sub-agent 的记录如何处理；canonical `messages + tools` 到 trainer-facing ms-swift 的精确投影；暂时保留的 `developer` role 何时以及如何转换。
3. **配比冲突与确定性 tie-break**：记录同时落入多个 bucket 时如何组合 `bucket_weight`/`max_quota`，约束冲突如何报告，以及 `selection_score` 相同时按什么稳定次序截取。
4. **Generator workspace adapter**：绑定哪个目标 DSH 公共 API；隔离、路径围栏、shell/网络、锁定依赖、资源限制、清理与归档生命周期的精确合同。已确认的是隔离 workspace、受限工具、允许 shell/网络读取、不得新增未锁定依赖，以及 snapshot 为真相；不能借实现细节推翻这些边界。
5. **两个 child session 的实际编排**：Diagnosis 与 Generator 的创建/关闭顺序、输入输出 schema、工具权限、超时和失败映射；Q9/Q18 已确认角色方向，但具体运行合同未冻结。
6. **首版数值和 pinned profile**：`max_records` 的具体值；SWE-bench Full 数据 revision、dev/test manifest、镜像、evaluator、mini-SWE-agent 与模型/训练 recipe 的完整 pins。

### Implementation-spec pending（不等于用户尚未同意方向）

- canonical JSON 的精确编码、hash/version 表示、碰撞和迁移处理；R22 已决定使用来源中立的版本化内容哈希。
- run/round/candidate/job ID、幂等键、状态机、未知远端作业的对账与崩溃恢复细节；R27/R28 已决定职责和重试语义。
- CandidateSnapshot、manifest、TrainingViewEntry、evaluation artifact 和 archive 的字段级 schema、索引与读取 API；相应领域对象和证据保留方向已经确认。
- Trainer、TaskRunner、evaluator 与 artifact store adapter 的命令、超时、资源值和错误码映射。

这些实现项应在设计问题关闭后形成实现计划和测试；只有遇到会改变已确认研究协议或权限边界的取舍时，才重新向用户提问。

### 已明确延期，不阻塞首版跑通

- R24 的 baseline 重跑/多 seed 稳定性验证；当前只记录单次结果限制。
- 第三层 promotion validation、`trajectory_valid`、N>1 多 active population 和质量评估 Agent；接口可预留，但首版不启用。
