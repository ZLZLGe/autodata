# AutoData

AutoData is a self-evolving data harness built as an external Bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It extends an unmodified DSH runtime through Cordis services and tools; it does not vendor the DSH monorepo.

## Current status

`0.1.0-rc.1` is the Stage 1 Bundle/lifecycle validation release. It provides:

- `ctx.autodata`, a deterministic in-memory status service;
- `autodata_status`, a read-only model-facing DSH tool;
- an installable `dsh.bundle.patch` layer;
- tarball/Profile tests covering installation, loading, visibility, and disposal.

Trajectory processing, DataPlugins, evolution control, persistence, Python training, and GPU evaluation are intentionally not implemented in this stage.

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- pnpm 11
- DeepSeek Harness `0.1.1-rc.2`

## Development

```sh
corepack enable
pnpm install
pnpm check
```

`pnpm test:profile` builds a package tarball in a temporary directory, installs it into an isolated DSH Profile, verifies the service and tool, and confirms clean disposal on shutdown. It does not call a model API.

## Install the local release candidate

Build a tarball, then install it through DSH:

```sh
pnpm pack
dsh plugin --profile autodata add ./zlzlge-autodata-0.1.0-rc.1.tgz
dsh --profile autodata --dump-config
dsh --profile autodata
```

The `autodata` Profile is useful for Bundle validation. Install the Bundle into `web` for an interactive surface, or into `headless` for one-shot tasks.

The npm package is configured as `@zlzlge/autodata` but has not yet been published. After publication, installation becomes:

```sh
dsh plugin --profile web add @zlzlge/autodata
dsh --profile web --dump-config
dsh --profile web
```

## Architecture boundary

DSH owns the agent loop, session log, prompt assembly, tool runtime, approvals, sandboxing, and Bundle loading. AutoData owns only its data-processing and evolution capabilities. The long-term evolving state is the AutoData `DataPlugin` graph, not the DSH runtime.

## License

MIT
