// Finds the round as of a date. Usage: tsx examples/date-to-round.ts [ISO date, default 2025-06-01T00:00:00Z]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

const date = new Date(process.argv[2] ?? "2025-06-01T00:00:00Z")

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })
  let probes = 0
  const start = performance.now()
  const { round, timestamp } = await sdk.clock.roundAt(date, { onProbe: () => probes++ })
  const ms = performance.now() - start
  console.log(`${date.toISOString()} -> round ${round} (${new Date(timestamp * 1000).toISOString()}), ${probes} header reads, ${ms.toFixed(0)}ms`)
  console.log(`next round's timestamp: ${new Date((await sdk.timestampOf(round + 1n)) * 1000).toISOString()}`)
  console.log("registry totals then:", await sdk.getRegistryTotals({ round }))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
