// Refuses to publish a prerelease (0.3.0-dt.N) as `latest`, which would replace the stable SDK
// for everyone running `npm install reti-ghost-sdk`. Publish with `--tag dt`.
import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const tag = process.env.npm_config_tag || "latest"

if (version.includes("-") && tag === "latest") {
  console.error(`reti-ghost-sdk ${version} is a prerelease: publish it with --tag dt, not as latest.`)
  process.exit(1)
}
