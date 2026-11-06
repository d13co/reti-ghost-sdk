// Keeps the dt line's release metadata consistent, and checks it before a release: the SDK version, the npm dist-tag,
// and the fork versions named in pnpm-workspace.yaml, the package.json files and the READMEs.
//
// Usage:
//   node scripts/ci/dt-release.mjs update        rewrite the READMEs' fork versions from pnpm-workspace.yaml and projects/contracts
//   node scripts/ci/dt-release.mjs check [tag]   fail if anything disagrees, or the tag isn't v<version>
//
// The fork versions come from the `overrides` in pnpm-workspace.yaml (algosdk, algokit-utils) and the ghostkit pin in
// projects/contracts/package.json.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = new URL("../..", import.meta.url).pathname
const read = (file) => readFileSync(join(root, file), "utf8")
const readJson = (file) => JSON.parse(read(file))

const VERSION_FORMAT = /^\d+\.\d+\.\d+-dt\.\d+$/
const DIST_TAG = "beta"
const SDK_README = "projects/sdk/README.md"
const ROOT_README = "README.md"

const [mode, tag] = process.argv.slice(2)
const sdk = readJson("projects/sdk/package.json")
const contracts = readJson("projects/contracts/package.json")

// `algosdk: npm:dt-algosdk@3.9.0-dt.5.2.0.0` in pnpm-workspace.yaml's overrides
function override(name, fork) {
  const line = read("pnpm-workspace.yaml")
    .split("\n")
    .find((l) => new RegExp(`^\\s+'?${name.replace(/[/@]/g, "\\$&")}'?:\\s*npm:${fork.replace(/[/@]/g, "\\$&")}@`).test(l))
  const version = line?.match(/@([^@\s'"]+)\s*$/)?.[1]
  if (!version) throw new Error(`pnpm-workspace.yaml has no override of ${name} to npm:${fork}@<version>`)
  return version
}

const forks = [
  { name: "algosdk", fork: "dt-algosdk", version: override("algosdk", "dt-algosdk") },
  {
    name: "@algorandfoundation/algokit-utils",
    fork: "@d13co/dt-algokit-utils",
    version: override("@algorandfoundation/algokit-utils", "@d13co/dt-algokit-utils"),
  },
]
const ghostkit = contracts.dependencies?.ghostkit ?? contracts.devDependencies?.ghostkit

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/@]/g, "\\$&")
// `npm:<fork>@<version>` in the SDK README's install snippet
const snippetRef = (fork) => new RegExp(`(npm:${esc(fork)}@)([^"\\s]+)`, "g")
// the version cell of a fork's row in the root README's table: | algosdk | `dt-algosdk` | `3.9.0-dt.5.2.0.0` |
const tableRef = (fork) => new RegExp(`(^\\| [^|]+ \\| \`${esc(fork)}\` \\| \`)([^\`]+)(\`)`, "gm")
const tableForks = [...forks.map(({ fork, version }) => ({ fork, version })), { fork: "ghostkit", version: ghostkit }]

if (mode === "update") {
  const files = {
    [SDK_README]: (text) =>
      forks.reduce((t, { fork, version }) => t.replace(snippetRef(fork), (_, pre) => `${pre}${version}`), text),
    [ROOT_README]: (text) =>
      tableForks.reduce((t, { fork, version }) => t.replace(tableRef(fork), (_, pre, _v, post) => `${pre}${version}${post}`), text),
  }
  for (const [file, rewrite] of Object.entries(files)) {
    const text = read(file)
    const updated = rewrite(text)
    writeFileSync(join(root, file), updated)
    console.log(`${file}: ${text === updated ? "unchanged" : "updated"}`)
  }
} else if (mode === "check") {
  const errors = []
  const { version } = sdk
  if (sdk.name !== "reti-ghost-sdk") errors.push(`projects/sdk/package.json name is ${sdk.name}`)
  if (!VERSION_FORMAT.test(version)) errors.push(`version ${version} is not <x.y.z>-dt.<N>`)
  if (sdk.publishConfig?.tag !== DIST_TAG) errors.push(`projects/sdk/package.json publishConfig.tag is not ${DIST_TAG}`)
  if (tag && tag !== `v${version}`) errors.push(`tag ${tag} is not v${version}`)

  for (const { name, fork, version: v } of forks) {
    for (const [file, pkg] of [["projects/sdk", sdk], ["projects/contracts", contracts]]) {
      const dep = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name]
      if (dep !== undefined && dep !== `npm:${fork}@${v}`) errors.push(`${file}/package.json: ${name} is ${dep}, not npm:${fork}@${v}`)
    }
    const refs = [...read(SDK_README).matchAll(snippetRef(fork))]
    if (refs.length === 0) errors.push(`${SDK_README}: no npm:${fork}@<version> in the install snippet`)
    for (const [ref, , found] of refs) if (found !== v) errors.push(`${SDK_README}: ${ref} is not ${v}`)
  }
  if (!ghostkit || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(ghostkit))
    errors.push(`projects/contracts/package.json: ghostkit is ${ghostkit}, not an exact npm version`)
  for (const { fork, version: v } of tableForks) {
    const refs = [...read(ROOT_README).matchAll(tableRef(fork))]
    if (refs.length !== 1) errors.push(`${ROOT_README}: ${refs.length} table rows for ${fork}, expected 1`)
    for (const [, , found] of refs) if (found !== v) errors.push(`${ROOT_README}: the ${fork} row says ${found}, not ${v}`)
  }
  for (const [file, pkg] of [["projects/sdk", sdk], ["projects/contracts", contracts]])
    for (const [dep, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
      if (/^(file|link):/.test(spec)) errors.push(`${file}/package.json: ${dep} is ${spec}; release from registry versions`)

  if (errors.length) {
    errors.forEach((e) => console.error(e))
    console.error("Run `node scripts/ci/dt-release.mjs update` after changing a fork version")
    process.exit(1)
  }
  console.log(
    `reti-ghost-sdk ${version} (npm tag ${DIST_TAG}) is consistent${tag ? ` with ${tag}` : ""}: ` +
      tableForks.map(({ fork, version: v }) => `${fork} ${v}`).join(", "),
  )
} else {
  console.error("Usage: dt-release.mjs update | check [tag]")
  process.exit(1)
}
