// Lists every change of a pool's reported algod version, then checks the latest change against a read at its round.
// Usage: tsx examples/pool-upgrades.ts [poolAppId, default 2714622967]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID, timed } from "./common"

const poolAppId = BigInt(process.argv[2] ?? 2714622967)

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })

  // the pool's whole history: 1–2 requests on a node with versions key filters
  const changes = await timed("algodVer changes", () => sdk.getPoolAlgodVersionChanges(poolAppId))
  for (const c of changes) console.log(c.round, new Date(c.timestamp * 1000).toISOString(), c.algodVer || "(none)")
  console.log(`${changes.length} changes`)

  // the latest change, read back at its round and the round before
  const last = changes.at(-1)
  if (last) {
    const [before] = await sdk.getPoolAlgodVersions([poolAppId], { round: last.round - 1n })
    const [after] = await sdk.getPoolAlgodVersions([poolAppId], { round: last.round })
    console.log(`round ${last.round - 1n}: ${before || "(none)"}\nround ${last.round}: ${after || "(none)"}`)
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
