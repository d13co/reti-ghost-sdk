// Chart series: every validator's and pool's stake at evenly spread rounds, and the registry totals.
// Usage: tsx examples/series.ts [points, default 256]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID, timed } from "./common"

const points = Number(process.argv[2] ?? 256)

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })
  const from = (await sdk.getRegistryCreationRound())! + 1_000n
  const { round: to } = await sdk.clock.latest()
  const { numValidators } = await sdk.getRegistryTotals()
  const ids = Array.from({ length: numValidators }, (_, i) => i + 1)

  const registry = await timed(`registry totals x${points}`, () => sdk.getRegistryTotalsSeries({ from, to, points }))
  console.log("registry staked, first and last:", registry[0], registry.at(-1))

  // validators that don't exist yet at a round read as zeros
  const validators = await timed(`validator totals: ${ids.length} validators x${points} rounds`, () =>
    sdk.getValidatorTotalsSeries(ids, { from, to, points }),
  )
  const failed = validators.filter((p) => !p.ok)
  console.log(`${validators.length} points, ${failed.length} failed`, failed[0] && !failed[0].ok ? failed[0].error.message : "")
  const sum = (p: (typeof validators)[number]) => (p.ok ? p.value.reduce((n, v) => n + v.totalAlgoStaked, 0n) : undefined)
  console.log("sum of validator stake vs registry total, at the last point:", sum(validators.at(-1)!), registry.at(-1)!.ok && (registry.at(-1) as { value: { staked: bigint } }).value.staked)

  const pools = (await sdk.getPools(ids)).flat().map((p) => p.poolAppId)
  const poolSeries = await timed(`pool totals: ${pools.length} pools x${points} rounds`, () => sdk.getPoolTotalsSeries(pools, { from, to, points }))
  console.log(`${poolSeries.filter((p) => p.ok).length}/${poolSeries.length} points ok`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
