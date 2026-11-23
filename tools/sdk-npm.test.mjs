// tools/sdk-npm.test.mjs — the npm package of an SDK version is that version's release folder, byte for byte (tools/sdk-npm.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildPackage, checkPackage, packageJson, SDK_DIR, NAME, REPOSITORY } from './sdk-npm.mjs'

const latest = JSON.parse(readFileSync(join(SDK_DIR, 'versions.json'), 'utf8'))
const newest = Array.isArray(latest) ? latest[0] : (latest.latest || latest.versions[0])
const tmp = () => mkdtempSync(join(tmpdir(), 'sdk-npm-'))

test('the newest release builds into a package that IS the release folder, plus npm\'s three files', () => {
  const out = join(tmp(), 'pkg')
  try {
    const files = buildPackage(String(newest), out)
    const rel = readdirSync(join(SDK_DIR, String(newest)))
    assert.deepEqual([...files].sort(), [...rel, 'package.json', 'README.md', 'LICENSE'].sort())
    for (const f of rel) assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(SDK_DIR, String(newest), f))), f)
    const pj = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    assert.equal(pj.name, NAME); assert.equal(pj.version, String(newest)); assert.equal(pj.type, 'module')
    assert.equal(pj.repository.url, REPOSITORY, 'trusted publishing needs the publishing repository named exactly')
    assert.deepEqual(pj.exports['.'], { types: './witbitz-sdk.d.ts', default: './witbitz-sdk.js' })
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('npm packs exactly those files', () => {
  const out = join(tmp(), 'pkg')
  try {
    buildPackage(String(newest), out)
    const [r] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: out, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    const packed = r.files.map((f) => f.path).sort()
    assert.deepEqual(packed, readdirSync(out).sort())
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('a changed byte, an added file or a removed one is refused — the check the publish workflow runs last', () => {
  const v = String(newest)
  for (const spoil of [
    (d) => writeFileSync(join(d, 'witbitz-sdk.js'), readFileSync(join(d, 'witbitz-sdk.js'), 'utf8') + '\n// x'),
    (d) => writeFileSync(join(d, 'extra.js'), 'export {}'),
    (d) => rmSync(join(d, 'manifest.json')),
    (d) => writeFileSync(join(d, 'package.json'), JSON.stringify({ ...packageJson(v, []), version: '9.9.9' })),
  ]) {
    const out = join(tmp(), 'pkg')
    try { buildPackage(v, out); spoil(out); assert.throws(() => checkPackage(v, out)) } finally { rmSync(out, { recursive: true, force: true }) }
  }
})

test('a release folder whose file no longer matches its manifest cannot become a package', () => {
  const sdk = tmp(), v = String(newest)
  try {
    cpSync(join(SDK_DIR, v), join(sdk, v), { recursive: true })
    writeFileSync(join(sdk, v, 'witbitz-sdk.js'), '// changed')
    assert.throws(() => buildPackage(v, join(sdk, 'out'), { sdkDir: sdk }), /does not match manifest\.json/)
  } finally { rmSync(sdk, { recursive: true, force: true }) }
})

test('a version that is not released, or not a version, is refused', () => {
  assert.throws(() => buildPackage('99.0.0', join(tmp(), 'p')), /no release 99\.0\.0/)
  assert.throws(() => buildPackage('../x', join(tmp(), 'p')), /not a version/)
})
