// Reads everything the Reti UI shows, as of one round. Usage: tsx examples/at-round.ts [round|latest]
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID, timed } from "./common"

const arg = process.argv[2]
const round = arg && arg !== "latest" ? BigInt(arg) : undefined

;(async () => {
  const algorand: AlgorandClient = dtAlgorand()
  // every read of `sdk` is as of `round`: all chunks see the same state
  const sdk = new RetiGhostSDK({ algorand, registryAppId: REGISTRY_APP_ID }).atRound(round)
  console.log("node:", JSON.stringify(await sdk.getNode()))
  console.log("registry created at round", await sdk.getRegistryCreationRound())
  console.log(`=== ${round ?? "latest"}${round ? ` (${new Date((await sdk.timestampOf(round)) * 1000).toISOString()})` : ""}`)

  const totals = await timed("getRegistryTotals", () => sdk.getRegistryTotals())
  console.log(totals)
  const ids = Array.from({ length: totals.numValidators }, (_, i) => i + 1)

  const validators = await timed(`getValidators x${ids.length}`, () => sdk.getValidators(ids))
  if (!validators.length) return console.log("no validators yet")
  console.log("validator 1 state", validators[0].state)
  // poolInfo entries are [poolAppId, totalStakers, totalAlgoStaked] tuples
  const poolAppIds = validators.flatMap((v) => v.poolInfo.map(([poolAppId]) => poolAppId))

  await timed(`getValidatorConfig x${ids.length}`, () => sdk.getValidatorConfig(ids))
  await timed(`getValidatorStates x${ids.length}`, () => sdk.getValidatorStates(ids))
  const pools = await timed(`getPools x${ids.length}`, () => sdk.getPools(ids))
  console.log("pools match getValidators:", pools.flat().length === poolAppIds.length)
  await timed(`getNodePoolAssignments x${ids.length}`, () => sdk.getNodePoolAssignments(ids))
  await timed(`getValidatorTotals x${ids.length}`, () => sdk.getValidatorTotals(ids))

  const poolStates = await timed(`getPoolStates x${poolAppIds.length}`, () => sdk.getPoolStates(poolAppIds))
  console.log("pool 1 state", poolStates[0])
  await timed(`getPoolTotals x${poolAppIds.length}`, () => sdk.getPoolTotals(poolAppIds))
  await timed(`getPoolBalancesAndLastPayouts x${poolAppIds.length}`, () => sdk.getPoolBalancesAndLastPayouts(poolAppIds))
  await timed(`getPoolAlgodVersions x${poolAppIds.length}`, () => sdk.getPoolAlgodVersions(poolAppIds))

  const { mbrAmounts } = await timed("getMbrAmountsAndProtocolConstraints", () => sdk.getMbrAmountsAndProtocolConstraints())
  console.log("mbr", mbrAmounts)
  const timestamps = await timed("getBlockTimestamps(10)", () => sdk.getBlockTimestamps(10))
  console.log("last block timestamp", timestamps.at(-1))

  const stakers = await timed("getPoolStakers(pool 1)", () => sdk.getPoolStakers(poolAppIds[0]))
  console.log(`pool 1 has ${stakers.length} stakers`)
  if (stakers.length) {
    const staker = stakers[0].account
    const positions = await timed("getStakerPositions", () => sdk.getStakerPositions([staker]))
    console.log(`staker ${staker}: ${positions.length} positions`, positions.map((p) => `${p.validatorId}/${p.poolId}: ${p.info.balance}`))
    console.log(await timed("getAccountBalances", () => sdk.getAccountBalances([staker])))
  }

  const rewardTokens = [...new Set(validators.map((v) => v.config.rewardTokenId).filter((id) => id > 0n))]
  const assets = await timed(`getAssets x${rewardTokens.length}`, () => sdk.getAssets(rewardTokens))
  console.log("reward tokens", assets.map((a) => ("params" in a ? `${a.index}:${a.params.unitName}` : `${a.index}:deleted`)).join(" "))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
