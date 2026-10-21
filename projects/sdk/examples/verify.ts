// Cross-checks the SDK's past-round reads against plain REST reads of the same round, at rounds spread over the
// registry's life and around every change of its program. Usage: tsx examples/verify.ts [points, default 64]
import { ABIType, getApplicationAddress, type Algodv2 } from "algosdk"
import { RetiGhostSDK, type ValidatorConfig, type ValidatorCurState } from "../src"
import { pMap } from "../src/utils/p-map"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

const points = Number(process.argv[2] ?? 64)

const CONFIG = ABIType.from("(uint64,address,address,uint64,uint8,address,uint64[4],uint64,uint64,uint64,uint32,uint32,address,uint64,uint64,uint8,uint64,uint64)")
const STATE = ABIType.from("(uint16,uint64,uint64,uint64)")
const POOL = ABIType.from("(uint64,uint16,uint64)")
const configTuple = (c: ValidatorConfig) => [
  c.id, c.owner, c.manager, c.nfdForInfo, c.entryGatingType, c.entryGatingAddress, c.entryGatingAssets, c.gatingAssetMinBalance,
  c.rewardTokenId, c.rewardPerPayout, c.epochRoundLength, c.percentToValidator, c.validatorCommissionAddress, c.minEntryStake,
  c.maxAlgoPerPool, c.poolsPerNode, c.sunsettingOn, c.sunsettingTo,
]
const stateTuple = (s: ValidatorCurState) => [s.numPools, s.totalStakers, s.totalAlgoStaked, s.rewardTokenHeldBack]
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

type Problem = { round: bigint; what: string }

;(async () => {
  const algorand = dtAlgorand()
  const sdk = new RetiGhostSDK({ algorand, registryAppId: REGISTRY_APP_ID })
  const algod = algorand.client.algod as Algodv2
  const dt = algorand.client.dtAlgod
  const created = (await sdk.getRegistryCreationRound())!
  const { round: latest } = await sdk.clock.latest()

  // rounds where the registry's program changed: bisect on the approval program hash
  const programAt = async (round: bigint) => hex((await dt.getApplicationByID(REGISTRY_APP_ID).round(round).do()).params!.approvalProgram)
  const changes: bigint[] = []
  const findChanges = async (lo: bigint, loProg: string, hi: bigint, hiProg: string): Promise<void> => {
    if (loProg === hiProg) return
    if (hi - lo === 1n) return void changes.push(hi)
    const mid = lo + (hi - lo) / 2n
    const midProg = await programAt(mid)
    await findChanges(lo, loProg, mid, midProg)
    await findChanges(mid, midProg, hi, hiProg)
  }
  await findChanges(created, await programAt(created), latest, await programAt(latest))
  console.log(`registry program changed at rounds: ${changes.join(", ") || "never"}`)

  const spread = Array.from({ length: points }, (_, i) => created + 1n + ((latest - created - 1n) * BigInt(i)) / BigInt(points - 1))
  const rounds = [...new Set([...spread, ...changes.flatMap((r) => [r - 1n, r])])].sort((a, b) => (a < b ? -1 : 1))
  const problems: Problem[] = []
  const check = (round: bigint, ok: boolean, what: string) => {
    if (!ok) problems.push({ round, what })
  }
  let checked = 0

  await pMap(
    rounds,
    async (round) => {
      const at = sdk.atRound(round)
      const totals = await at.getRegistryTotals()
      const ids = Array.from({ length: totals.numValidators }, (_, i) => i + 1)
      if (!ids.length) return

      // validators: SDK (inner calls to the registry) vs the registry's `v` boxes over REST
      const [validators, boxes] = await Promise.all([
        at.getValidators(ids),
        algod.getApplicationBoxes(REGISTRY_APP_ID).include("values").prefix(new TextEncoder().encode("v")).round(round).limit(1000).do(),
      ])
      const byId = new Map(boxes.boxes.map((b) => [new DataView(b.name.buffer, b.name.byteOffset).getBigUint64(1), b.value!]))
      check(round, byId.size === ids.length, `${byId.size} validator boxes, ${ids.length} validators`)
      let staked = 0n
      for (const v of validators) {
        const box = byId.get(v.config.id)
        if (!box) {
          check(round, false, `no box for validator ${v.config.id}`)
          continue
        }
        check(round, hex(CONFIG.encode(configTuple(v.config))) === hex(box.slice(0, 242)), `validator ${v.config.id} config`)
        check(round, hex(STATE.encode(stateTuple(v.state))) === hex(box.slice(242, 268)), `validator ${v.config.id} state`)
        const boxPools = Array.from({ length: v.state.numPools }, (_, i) => hex(box.slice(268 + i * 18, 286 + i * 18)))
        check(round, hex(Buffer.concat(v.poolInfo.map((p) => POOL.encode(p)))) === boxPools.join(""), `validator ${v.config.id} pools`)
        staked += v.state.totalAlgoStaked
      }
      check(round, staked === totals.staked, `sum of validator stake ${staked} != registry staked ${totals.staked}`)

      // pools: SDK (app_global_get_ex, balance) vs the registry account's created apps and the pool accounts, over REST
      const poolIds = validators.flatMap((v) => v.poolInfo.map(([id]) => id))
      const [states, registryAccount] = await Promise.all([
        at.getPoolStates(poolIds),
        dt.accountInformation(getApplicationAddress(REGISTRY_APP_ID)).round(round).do(),
      ])
      const restPools = new Map((registryAccount.createdApps ?? []).map((a) => [a.id, a.params?.globalState ?? []]))
      for (const s of states) {
        const gs = restPools.get(s.poolAppId)
        if (!gs) {
          check(round, false, `pool ${s.poolAppId} not in the registry's created apps`)
          continue
        }
        const uint = (key: string) => gs.find((kv) => new TextDecoder().decode(kv.key) === key)?.value.uint ?? 0n
        for (const key of ["numStakers", "staked", "lastPayout", "epochNumber", "validatorId", "poolId"] as const) {
          check(round, s[key] === BigInt(uint(key)), `pool ${s.poolAppId} ${key}: ${s[key]} vs ${uint(key)}`)
        }
      }
      // pool balances, for a sample
      for (const s of states.slice(0, 3)) {
        const acct = await dt.accountInformation(getApplicationAddress(s.poolAppId)).round(round).do()
        check(round, acct.amount === s.balance, `pool ${s.poolAppId} balance ${s.balance} vs ${acct.amount}`)
      }

      // a staker: positions vs the pool's stakers box, balance vs REST
      const stakers = await at.getPoolStakers(poolIds[0])
      if (stakers.length) {
        const staker = stakers[0]
        const [positions, [balance], acct] = await Promise.all([
          at.getStakerPositions([staker.account]),
          at.getAccountBalances([staker.account]),
          dt.accountInformation(staker.account).round(round).do(),
        ])
        const inPool = positions.find((p) => p.poolAppId === poolIds[0])
        check(round, inPool?.info.balance === staker.balance, `staker ${staker.account} position ${inPool?.info.balance} vs box ${staker.balance}`)
        check(round, balance.balance === acct.amount, `staker ${staker.account} balance ${balance.balance} vs ${acct.amount}`)
      }
      checked++
    },
    { concurrency: 4 },
  )

  console.log(`checked ${checked} rounds (${rounds.length} with the registry existing or not)`)
  if (problems.length) {
    console.log(`${problems.length} mismatches:`)
    for (const p of problems.slice(0, 30)) console.log(`  round ${p.round}: ${p.what}`)
    process.exit(1)
  }
  console.log("all reads match")
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
