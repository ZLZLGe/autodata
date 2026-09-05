# AutoData 开发规则

- AutoData 是一个仓库外的 DeepSeek Harness Bundle。除非先证明存在公共扩展点无法满足的缺口并获得批准，否则不要复制或修改 DSH 源码树。
- AutoData 的活跃仓库是 `/root/autodata`；`/root/dataharness` 只作为早期实现参考，任务未明确指向旧 DataHarness 时不得在那里开发。
- 以 DSH 的会话、Agent、工具、审批和沙箱为权威。AutoData 应使用它们公开的 Service、Event、Plugin、Bundle 和 Profile 接口。
- 没有明确需求和批准，不要添加运行时完整性锁、CAS 存储、重复内容哈希或第二套会话/工具运行时。
- AutoData 的领域逻辑、EvolutionHost 和持久化控制面保持 TypeScript。Python 仅作为 Trainer、Evaluator 等 adapter 的外部执行端；首版可以通过 DSH Job 或可替换的 ExecutionBackend 调度真实训练和 GPU 作业，但不得把 Python 训练栈或第二套运行时嵌入 Core。
- 大型或可重新生成的数据、日志、checkpoint 和实验输出放在 `/data/codex-work/autodata/` 下，不要放入本仓库。
- 提交可执行改动前运行 `pnpm check`。保持提交目的聚焦，绝不要包含凭据或生成的 tarball。
