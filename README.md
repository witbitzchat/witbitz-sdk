# The Witbitz SDK — released versions

This repository holds the released versions of the Witbitz SDK, exactly as they are served at
`https://witbitz.chat/sdk/<version>/`, and publishes each one to npm as
[`@witbitz/sdk`](https://www.npmjs.com/package/@witbitz/sdk).

```sh
npm install @witbitz/sdk
```

```js
import { Witbitz } from '@witbitz/sdk'
```

The guide: https://witbitz.chat/docs/sdk · what changed in each version: https://witbitz.chat/docs/sdk-changes

## What is here

- `sdk/<version>/` — a release: every file the SDK is made of, and `manifest.json` with the sha384 of each one. A released
  folder never changes.
- `tools/sdk-npm.mjs` — makes the npm package of a version: that folder unchanged, plus `package.json`, `README.md` and `LICENSE`.
  It checks every file against the folder and its manifest before anything is published (`tools/sdk-npm.test.mjs`).
- `.github/workflows/npm-publish.yml` — publishes a version to npm with npm's trusted publishing: no token is stored anywhere,
  and npm records where and from which commit each version was built (its provenance).

## Check it yourself

A version on npm is this repository's `sdk/<version>/` folder and the same bytes as the hosted release:

```sh
npm pack @witbitz/sdk@<version> && tar xzf witbitz-sdk-<version>.tgz
curl -sO https://witbitz.chat/sdk/<version>/manifest.json
diff package/manifest.json manifest.json && node -e "
const m = require('./manifest.json'), c = require('crypto'), fs = require('fs')
for (const [f, h] of Object.entries(m.files)) if ('sha384-' + c.createHash('sha384').update(fs.readFileSync('package/' + f)).digest('base64') !== h) throw f
console.log('every file matches the manifest')"
```

The SDK is developed in Witbitz's own repository; each release is copied here when it is cut. Issues and questions are welcome here.

MIT licensed.
