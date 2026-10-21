// Removes the base64 TEAL `source` member from the ARC-56 APP_SPEC in the generated reader SDK. Reads only need
// `byteCode` and `sourceInfo`; `source` (~96 kB) is only used to compile templates and to show TEAL lines in
// LogicError messages, and the ghost reader never deploys. Fails if a `source` is present in a shape it can't strip,
// so a generator change can't silently undo it.
import { readFileSync, writeFileSync } from "node:fs"

const file = process.argv[2]
if (!file) throw new Error("usage: strip-app-spec-source.mjs <file>")

const HAS_SOURCE = /"source"\s*:\s*\{\s*"approval"/
const SOURCE_MEMBER = /"source"\s*:\s*\{\s*"approval"\s*:\s*"[A-Za-z0-9+/=]*"\s*,\s*"clear"\s*:\s*"[A-Za-z0-9+/=]*"\s*\}\s*,?/g

const code = readFileSync(file, "utf8")
if (!HAS_SOURCE.test(code)) {
  console.log(`strip-app-spec-source: no APP_SPEC source in ${file}`)
  process.exit(0)
}
const stripped = code.replace(SOURCE_MEMBER, "")
if (HAS_SOURCE.test(stripped)) throw new Error(`strip-app-spec-source: APP_SPEC source in ${file} has an unexpected shape`)
writeFileSync(file, stripped)
console.log(`strip-app-spec-source: removed ${code.length - stripped.length} bytes from ${file}`)
