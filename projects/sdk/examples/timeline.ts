// Lists when a validator changed, then reads its state just before and after the latest change.
// Usage: tsx examples/timeline.ts [validatorId, default 1]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID, timed } from "./common"

const validatorId = BigInt(process.argv[2] ?? 1)

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })

  // the last 20 changes: one request, newest first
  const { changes } = await timed("last 20 changes", () => sdk.getChangeRounds({ validator: validatorId }, { limit: 20 }))
  for (const c of changes.slice(0, 5)) console.log(c.round, new Date(c.timestamp * 1000).toISOString(), c.deleted ? "deleted" : "")

  // a window: every change in the ~2 weeks (432,000 rounds at 2.8s) before the latest change
  const last = changes[0].round
  const windowed = await timed("2-week window", () =>
    sdk.getChangeRounds({ validator: validatorId }, { minRound: last - 432_000n, maxRound: last, limit: 10_000 }),
  )
  console.log(`${windowed.changes.length} changes in the 2 weeks to round ${last}${windowed.next ? " (more pages)" : ""}`)

  // what the latest change did
  const [before] = await sdk.getValidatorStates([validatorId], { round: last - 1n })
  const [after] = await sdk.getValidatorStates([validatorId], { round: last })
  console.log("before", before)
  console.log("after ", after)

  // other targets
  const pool = (await sdk.getPools([validatorId]))[0][0]?.poolAppId
  if (pool) {
    console.log("pool global state changes:", (await sdk.getChangeRounds({ pool }, { limit: 3 })).changes.map((c) => c.round))
    console.log("pool stakers box changes:", (await sdk.getChangeRounds({ poolStakers: pool }, { limit: 3 })).changes.map((c) => c.round))
  }
  console.log("registry changes:", (await sdk.getChangeRounds({ registry: true }, { limit: 3 })).changes.map((c) => c.round))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
