# AutoData Development Rules

- AutoData is an out-of-tree DeepSeek Harness Bundle. Do not copy or patch the DSH source tree unless a public extension-point gap has first been demonstrated and approved.
- Keep DSH sessions, agents, tools, approvals, and sandboxing authoritative. AutoData should consume their public Service, Event, Plugin, Bundle, and Profile interfaces.
- Do not add runtime integrity locks, CAS storage, repeated content hashes, or a second session/tool runtime without a concrete requirement and approval.
- Keep the first release TypeScript-only. Python, model training, GPU jobs, and the evolution controller belong to later approved stages.
- Put large or reproducible data, logs, checkpoints, and experiment outputs under `/data/codex-work/autodata/`, not in this repository.
- Run `pnpm check` before committing executable changes. Preserve focused commits and never include credentials or generated tarballs.
