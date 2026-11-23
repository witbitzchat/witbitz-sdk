#!/usr/bin/env node
// tools/sdk-npm.mjs — THE SDK ON npm, as `@witbitz/sdk`. The npm package of a version IS that version's release folder, sdk/<v>/ — the bytes
// builders already load from https://witbitz-spaces.pages.dev/sdk/<v>/ — copied unchanged, plus three files that are only npm's:
// package.json, README.md, LICENSE. Nothing is rebuilt: a release folder is immutable and held to its manifest.json
// (by its own tests where it is made), and checkPackage below holds the package to the same manifest, file by file.
//
//   node tools/sdk-npm.mjs 4.0.2 --out <dir>     write the package into <dir> (must be empty or missing) and check it
//   node tools/sdk-npm.mjs 4.0.2 --check <dir>   check a package folder (what the publish workflow runs right before publishing)
//
// Published ONLY by .github/workflows/npm-publish.yml of github.com/witbitzchat/witbitz-sdk (npm's trusted publishing: no token).
// This file is the same in that public repository and in the repository the SDK is made in; it finds the release folders in
// sdk/ (the public repository) or spaces/public/sdk/ (where releases are cut), or in $SDK_DIR.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SDK_DIR = process.env.SDK_DIR || (existsSync(join(ROOT, 'sdk/versions.json')) ? join(ROOT, 'sdk') : join(ROOT, 'spaces/public/sdk'))
export const NAME = '@witbitz/sdk'
// npm's trusted publishing requires package.json's repository to name the publishing repository exactly.
export const REPOSITORY = 'git+https://github.com/witbitzchat/witbitz-sdk.git'
export const LICENSE_ID = 'MIT' // the same as witbitz-code (github.com/witbitzchat/witbitz-code)
export const NPM_ONLY = ['package.json', 'README.md', 'LICENSE']
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

const sri = (buf) => 'sha384-' + createHash('sha384').update(buf).digest('base64')

/** The release folder's manifest, refused unless it is the version asked for. */
export function manifestOf (version, sdkDir = SDK_DIR) {
  if (!SEMVER.test(String(version))) throw new Error(`not a version: ${version}`)
  const dir = join(sdkDir, version)
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`no release ${version} (no ${dir}/manifest.json)`)
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  if (m.version !== version) throw new Error(`${dir}/manifest.json names version ${m.version}`)
  return { dir, manifest: m }
}

/** package.json for a release. `exports`: the SDK at the package's root, the server-side admin client at `/admin` (its one-file
 *  bundle), and every file of the release by its own name (a builder who loaded `/sdk/<v>/x.js` imports `@witbitz/sdk/x.js`). */
export function packageJson (version, files) {
  const has = (f) => files.includes(f)
  const exports = { '.': { types: './witbitz-sdk.d.ts', default: './witbitz-sdk.js' } }
  if (has('witbitz-admin.mjs')) exports['./admin'] = { ...(has('witbitz-admin.d.ts') ? { types: './witbitz-admin.d.ts' } : {}), default: './witbitz-admin.mjs' }
  exports['./package.json'] = './package.json'
  exports['./*'] = './*'
  return {
    name: NAME,
    version,
    description: 'The Witbitz SDK: Spaces — end-to-end encrypted rooms with an AI assistant — in your own app. The same bytes as https://witbitz-spaces.pages.dev/sdk/' + version + '/',
    type: 'module',
    main: './witbitz-sdk.js',
    types: './witbitz-sdk.d.ts',
    exports,
    ...(has('vault-kit.mjs') ? { bin: { 'witbitz-vault-kit': 'vault-kit.mjs' } } : {}),
    files: [...files].sort(),
    license: LICENSE_ID,
    homepage: 'https://witbitz.chat/docs/sdk',
    repository: { type: 'git', url: REPOSITORY },
    keywords: ['witbitz', 'spaces', 'end-to-end encryption', 'ai', 'chat', 'sdk'],
    engines: { node: '>=18' },
  }
}

export const readme = (version, commit) => `# @witbitz/sdk

The Witbitz SDK: Spaces — end-to-end encrypted rooms with an AI assistant — in your own app.

\`\`\`sh
npm install @witbitz/sdk
\`\`\`

\`\`\`js
import { Witbitz } from '@witbitz/sdk'
\`\`\`

On your server, the admin client: \`import { WitbitzAdmin } from '@witbitz/sdk/admin'\`. To build a vault kit: \`npx witbitz-vault-kit\`.

The guide: https://witbitz.chat/docs/sdk

## The same bytes as the hosted release

Version ${version} of this package is the release folder https://witbitz-spaces.pages.dev/sdk/${version}/ unchanged (from commit
\`${commit}\`), plus this README, \`package.json\` and \`LICENSE\`. Its \`manifest.json\` lists the sha384 of every file; each file in the
package matches it.
`

export const licenseText = () => `MIT License

Copyright (c) 2026 Witbitz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** The release's own files: everything in its folder (manifest.json included), and nothing that would collide with npm's three. */
export function releaseFiles (dir) {
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile())
  const clash = files.filter((f) => NPM_ONLY.includes(f))
  if (clash.length) throw new Error(`the release folder already has ${clash.join(', ')} — npm's files would replace them`)
  return files
}

/** Write the package for `version` into `out`. → the list of files written. */
export function buildPackage (version, out, { sdkDir = SDK_DIR } = {}) {
  const { dir, manifest } = manifestOf(version, sdkDir)
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty`)
  mkdirSync(out, { recursive: true })
  const files = releaseFiles(dir)
  for (const f of files) copyFileSync(join(dir, f), join(out, f))
  writeFileSync(join(out, 'package.json'), JSON.stringify(packageJson(version, files), null, 2) + '\n')
  writeFileSync(join(out, 'README.md'), readme(version, manifest.commit))
  writeFileSync(join(out, 'LICENSE'), licenseText())
  checkPackage(version, out, { sdkDir })
  return [...files, ...NPM_ONLY]
}

/** A package folder is the release: the same file list, each file byte-equal to the release folder's AND to its manifest hash,
 *  package.json's name, version and files as packageJson makes them. Throws with what differs. */
export function checkPackage (version, pkgDir, { sdkDir = SDK_DIR } = {}) {
  const { dir, manifest } = manifestOf(version, sdkDir)
  const rel = releaseFiles(dir)
  const got = readdirSync(pkgDir).filter((f) => statSync(join(pkgDir, f)).isFile())
  const missing = rel.filter((f) => !got.includes(f))
  const extra = got.filter((f) => !rel.includes(f) && !NPM_ONLY.includes(f))
  if (missing.length || extra.length) throw new Error(`the package is not the release: missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`)
  for (const f of rel) {
    const a = readFileSync(join(pkgDir, f)), b = readFileSync(join(dir, f))
    if (!a.equals(b)) throw new Error(`${f} differs from the release folder`)
    if (f !== 'manifest.json' && manifest.files[f] !== undefined && manifest.files[f] !== sri(a)) throw new Error(`${f} does not match manifest.json`)
  }
  const unlisted = rel.filter((f) => f !== 'manifest.json' && manifest.files[f] === undefined)
  if (unlisted.length) throw new Error(`files in the release that manifest.json does not list: ${unlisted.join(', ')}`)
  const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  if (JSON.stringify(pj) !== JSON.stringify(packageJson(version, rel))) throw new Error('package.json is not the one this tool makes for this release')
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, flag, target] = process.argv.slice(2)
  try {
    if (flag === '--out' && target) { const n = buildPackage(version, target).length; console.log(`${NAME}@${version}: ${n} files in ${target}, checked against the release folder and its manifest`) }
    else if (flag === '--check' && target) { checkPackage(version, target); console.log(`${NAME}@${version}: ${target} is the release`) }
    else { console.error('usage: node tools/sdk-npm.mjs <version> --out <dir> | --check <dir>'); process.exit(2) }
  } catch (e) { console.error('sdk-npm: ' + e.message); process.exit(1) }
}
