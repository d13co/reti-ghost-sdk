// A staker's deposits and withdrawals across every validator they were ever in, rebuilt from on-chain state.
// Usage: tsx examples/staker-history.ts <address> [validatorId]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID, timed } from "./common"

const staker = process.argv[2]
const validatorId = process.argv[3] ? BigInt(process.argv[3]) : undefined
if (!staker) {
  console.error("Usage: tsx examples/staker-history.ts <address> [validatorId]")
  process.exit(1)
}

const algo = (micro: bigint) => (Number(micro) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })

  // memberships only: one request, enough to list the validators used
  const pools = await timed("pools", () => sdk.getStakerPools(staker))
  for (const p of pools) {
    console.log(`validator ${p.validatorId} pool ${p.poolId} (app ${p.poolAppId}): rounds ${p.joinRound}…${p.leaveRound ?? "now"}`)
  }

  const history = await timed("history", () =>
    sdk.getStakerHistory(staker, {
      validatorId,
      onProgress: ({ pools, poolsListed, poolsDone, waves, reads, partial }) =>
        console.debug(`  listed ${poolsListed}/${pools}, done ${poolsDone}/${pools}, wave ${waves}, ${reads} rounds read, ${partial.events.length} events so far`),
    }),
  )
  console.log(`\n${history.events.length} events as of round ${history.round}, newest first:`)
  for (const e of history.events) {
    const flags = [e.joined && "joined", e.left && "left", e.approximate && "approximate", e.rewardTokenPaid && `+${e.rewardTokenPaid} reward tokens`].filter(Boolean)
    console.log(
      `${new Date(e.timestamp * 1000).toISOString()} round ${e.round} validator ${e.validatorId}/${e.poolId}: ${e.kind} ${algo(e.amount)} → ${algo(e.balanceAfter)} ALGO ${flags.join(", ")}`,
    )
  }
  const sum = (kind: string) => history.events.filter((e) => e.kind === kind).reduce((n, e) => n + e.amount, 0n)
  console.log(`\ndeposited ${algo(sum("deposit"))}, withdrawn ${algo(sum("withdrawal"))} ALGO`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
