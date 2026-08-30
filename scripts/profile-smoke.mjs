import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const scratch = mkdtempSync(join(tmpdir(), 'autodata-profile-smoke-'))
const packDirectory = join(scratch, 'pack')
const home = join(scratch, 'dsh-home')
const autodataHome = join(scratch, 'autodata-home')
const ready = join(scratch, 'ready.json')
const disposed = join(scratch, 'disposed')
let child

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error([
      `command failed: ${command} ${args.join(' ')}`,
      result.error?.stack ?? '',
      result.stdout ?? '',
      result.stderr ?? '',
    ].filter(Boolean).join('\n'))
  }
  return result
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status === 0) {
    throw new Error(`command unexpectedly succeeded: ${command} ${args.join(' ')}`)
  }
  return result
}

function assertMissingPeerFailure(cwd, entrypoint, peer) {
  const result = runFailure(process.execPath, [
    '--input-type=module',
    '--eval',
    `import(${JSON.stringify(entrypoint)})`,
  ], { cwd })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.includes('ERR_MODULE_NOT_FOUND') || !output.includes(peer)) {
    throw new Error(`missing peer dependency ${peer} did not fail clearly:\n${output}`)
  }
}

async function waitFor(path, closed, label) {
  const deadline = Date.now() + 30_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    const exit = await Promise.race([
      closed.then(value => ({ exit: value })),
      new Promise(resolveWait => setTimeout(() => resolveWait(undefined), 25)),
    ])
    if (exit?.exit !== undefined) {
      throw new Error(`dsh exited before ${label}: ${JSON.stringify(exit.exit)}`)
    }
  }
}

try {
  mkdirSync(packDirectory, { recursive: true })
  run('pnpm', ['pack', '--pack-destination', packDirectory])
  const tarballs = readdirSync(packDirectory).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`)
  const tarball = join(packDirectory, tarballs[0])

  const peerlessDirectory = join(scratch, 'peerless-consumer')
  mkdirSync(peerlessDirectory)
  writeFileSync(join(peerlessDirectory, 'package.json'), JSON.stringify({
    name: 'autodata-peerless-consumer',
    private: true,
    type: 'module',
  }))
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], {
    cwd: peerlessDirectory,
  })
  assertMissingPeerFailure(peerlessDirectory, '@zlzlge/autodata/service', '@deepseek-ai/cordis')
  assertMissingPeerFailure(peerlessDirectory, '@zlzlge/autodata/tool', '@deepseek-ai/dsh-tools')

  const env = {
    ...process.env,
    AUTODATA_HOME: autodataHome,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  run(dsh, ['plugin', '--profile', 'autodata', 'add', tarball], { env })

  const profileDirectory = join(home, 'profiles', 'autodata')
  const profile = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8'))
  if (!(profile.dependencies && profile.dependencies['@zlzlge/autodata'])) {
    throw new Error('profile dependency @zlzlge/autodata was not installed')
  }
  if (!profile.dsh?.profile?.bundles?.includes('@zlzlge/autodata')) {
    throw new Error('profile bundle list does not include @zlzlge/autodata')
  }

  const dump = run(dsh, ['--profile', 'autodata', '--dump-config'], { env }).stdout
  for (const expected of [
    'autodata-service',
    '@zlzlge/autodata/service',
    'autodata-tool',
    '@zlzlge/autodata/tool',
  ]) {
    if (!dump.includes(expected)) throw new Error(`dump-config is missing ${expected}`)
  }

  const probe = join(scratch, 'probe.mjs')
  const installedEntry = pathToFileURL(join(
    profileDirectory,
    'node_modules',
    '@zlzlge',
    'autodata',
    'lib',
    'index.js',
  )).href
  const candidateSource = `
    return {
      inject: ['autodata'],
      apply(ctx) {
        ctx.autodata.register({
          id: 'default-strategy',
          version: '1',
          run(input) {
            return input.map(item => ({ record_id: item.record.source.record_id }))
          },
        })
      },
    }
  `
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs'",
    `import { EVALUATION_REPORT_SCHEMA_VERSION, H0_CANDIDATE_ID, getEvolutionController } from ${JSON.stringify(installedEntry)}`,
    "export const name = 'autodata-smoke-probe'",
    "export const inject = ['autodata', 'loader', 'tools']",
    'export function apply(ctx) {',
    '  let active = true',
    '  const heartbeat = setInterval(() => {}, 1000)',
    '  const signal = new AbortController().signal',
    '  const execute = (name, argumentsValue, callId) => ctx.tools.execute({',
    '    signal, name, callId, arguments: argumentsValue,',
    '  })',
    '  void ctx.loader.await().then(async () => {',
    '    if (!active) return',
    "    const status = ctx.autodata.status()",
    "    const plugins = ctx.autodata.plugins()",
    "    const context = ctx.autodata.context()",
    '    const schemaNames = ctx.tools.schemas().map(schema => schema.name)',
    "    const evolutionStatus = await execute('autodata_evolution_status', { profile_id: 'default' }, 'profile-status')",
    "    const evolutionFeedback = await execute('autodata_evolution_feedback', { profile_id: 'default' }, 'profile-feedback')",
    '    const baseline = getEvolutionController(ctx).registerBaseline({',
    '      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,',
    "      report_id: 'default-smoke-h0-baseline',",
    "      profile_id: 'default',",
    '      candidate_id: H0_CANDIDATE_ID,',
    "      benchmark: 'autodata-fixture',",
    "      split: 'B_dev',",
    "      metric: 'score',",
    '      score: 0,',
    '      complete: true,',
    '      cases_evaluated: 1,',
    '      cases_expected: 1,',
    '    })',
    "    const candidate = await execute('autodata_submit_candidate', {",
    "      profile_id: 'default',",
    "      candidate_id: 'default-smoke-candidate',",
    "      strategy_version: '1',",
    `      host_source: ${JSON.stringify(candidateSource)},`,
    "      capabilities: ['data-select', 'data-filter', 'data-order'],",
    "    }, 'profile-candidate')",
    '    if (!active) return',
    '    writeFileSync(process.env.AUTODATA_SMOKE_READY, JSON.stringify({',
    '      status, plugins, context, schemaNames, evolutionStatus, evolutionFeedback, baseline, candidate,',
    '    }))',
    '  }).catch(error => {',
    '    writeFileSync(process.env.AUTODATA_SMOKE_READY, JSON.stringify({',
    "      probeError: error instanceof Error ? error.stack : String(error),",
    '    }))',
    '  })',
    '  ctx.effect(() => () => {',
    '    active = false',
    '    clearInterval(heartbeat)',
    "    writeFileSync(process.env.AUTODATA_SMOKE_DISPOSED, 'disposed')",
    '  })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(profileDirectory, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: autodata-smoke-probe',
    `      name: ${JSON.stringify(pathToFileURL(probe).href)}`,
    '',
  ].join('\n'))

  const stdout = []
  const stderr = []
  child = spawn(dsh, ['--profile', 'autodata'], {
    cwd: root,
    env: {
      ...env,
      AUTODATA_SMOKE_READY: ready,
      AUTODATA_SMOKE_DISPOSED: disposed,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => stdout.push(String(chunk)))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }))
  })

  await waitFor(ready, closed, 'AutoData ready marker')
  const observed = JSON.parse(readFileSync(ready, 'utf8'))
  if (observed.probeError) throw new Error(`AutoData probe failed: ${observed.probeError}`)
  if (observed.status?.version !== '0.1.0-rc.1' || observed.status?.ready !== true) {
    throw new Error(`unexpected AutoData status: ${JSON.stringify(observed)}`)
  }
  for (const toolName of [
    'autodata_status',
    'autodata_plugins',
    'autodata_evolution_status',
    'autodata_evolution_feedback',
    'autodata_submit_candidate',
  ]) {
    if (!observed.schemaNames?.includes(toolName)) throw new Error(`${toolName} is not visible in the DSH tool schema list`)
  }
  if (observed.plugins?.[0]?.id !== 'toolcall-h0') throw new Error(`unexpected plugin snapshot: ${JSON.stringify(observed)}`)
  if (observed.context?.schema_version !== 'autodata-context-1') throw new Error(`unexpected context snapshot: ${JSON.stringify(observed)}`)
  if (observed.evolutionStatus?.isError || observed.evolutionStatus?.value?.profile?.id !== 'default') {
    throw new Error(`default evolution status failed: ${JSON.stringify(observed.evolutionStatus)}`)
  }
  if (observed.evolutionFeedback?.isError || observed.evolutionFeedback?.value?.feedback !== null) {
    throw new Error(`default evolution feedback failed: ${JSON.stringify(observed.evolutionFeedback)}`)
  }
  if (observed.baseline?.status?.state?.active_evaluation?.candidate_id !== 'h0') {
    throw new Error(`default H0 baseline registration failed: ${JSON.stringify(observed.baseline)}`)
  }
  if (observed.candidate?.isError || observed.candidate?.value?.validation?.ok !== true) {
    throw new Error(`default candidate validation failed: ${JSON.stringify(observed.candidate)}`)
  }

  const defaultProfileDirectory = join(autodataHome, 'profiles', 'default')
  const persistedProfile = JSON.parse(readFileSync(join(defaultProfileDirectory, 'profile.json'), 'utf8'))
  const persistedState = JSON.parse(readFileSync(join(defaultProfileDirectory, 'state.json'), 'utf8'))
  if (persistedProfile.benchmark !== 'autodata-fixture' || persistedProfile.acceptance_policy?.metric !== 'score') {
    throw new Error(`unexpected persisted default Profile: ${JSON.stringify(persistedProfile)}`)
  }
  if (persistedState.active_candidate_id !== 'h0' || persistedState.open_candidate_id !== 'default-smoke-candidate') {
    throw new Error(`unexpected persisted default state: ${JSON.stringify(persistedState)}`)
  }
  const persistedCandidate = persistedState.candidates?.find(entry => entry.candidate_id === 'default-smoke-candidate')
  if (persistedCandidate?.status !== 'validated') {
    throw new Error(`default candidate was not persisted as validated/open: ${JSON.stringify(persistedState)}`)
  }
  for (const candidateFile of ['manifest.json', 'package-host.js']) {
    if (!existsSync(join(defaultProfileDirectory, 'candidates', 'default-smoke-candidate', candidateFile))) {
      throw new Error(`default candidate is missing ${candidateFile}`)
    }
  }

  child.kill('SIGTERM')
  const result = await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for DSH shutdown')), 30_000)),
  ])
  child = undefined
  if (result.code !== 0) {
    throw new Error(`DSH shutdown failed: ${JSON.stringify(result)}`)
  }
  if (!existsSync(disposed)) throw new Error('AutoData probe was not disposed during DSH shutdown')

  const installedPatch = join(profileDirectory, 'node_modules', '@zlzlge', 'autodata', 'cordis.patch.yml')
  const hiddenPatch = `${installedPatch}.missing`
  renameSync(installedPatch, hiddenPatch)
  try {
    const missingPatch = runFailure(dsh, ['--profile', 'autodata', '--dump-config'], { env })
    const missingPatchOutput = `${missingPatch.stdout ?? ''}\n${missingPatch.stderr ?? ''}`
    if (!missingPatchOutput.includes('failed to read overlay') || !missingPatchOutput.includes('cordis.patch.yml')) {
      throw new Error(`missing bundle patch did not fail clearly:\n${missingPatchOutput}`)
    }
  } finally {
    renameSync(hiddenPatch, installedPatch)
  }

  run(dsh, ['plugin', '--profile', 'autodata', 'remove', '@zlzlge/autodata'], { env })
  const removedProfile = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8'))
  if (removedProfile.dependencies?.['@zlzlge/autodata']) {
    throw new Error('profile dependency @zlzlge/autodata remained after removal')
  }
  if (removedProfile.dsh?.profile?.bundles?.includes('@zlzlge/autodata')) {
    throw new Error('profile bundle list still includes @zlzlge/autodata after removal')
  }
  const removedDump = run(dsh, ['--profile', 'autodata', '--dump-config'], { env }).stdout
  for (const removed of [
    'autodata-service',
    '@zlzlge/autodata/service',
    'autodata-tool',
    '@zlzlge/autodata/tool',
  ]) {
    if (removedDump.includes(removed)) throw new Error(`dump-config still contains ${removed} after removal`)
  }

  process.stdout.write('AutoData tarball/Profile smoke test passed.\n')
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
