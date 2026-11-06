// The SDK on stock algod: Nodely's MainNet node behind `stock-proxy.ts`, which hides its dtalgorand endpoints. Checks
// detection, that every latest-state read matches the same read on Nodely directly, how past, near and future rounds
// fail, Date → round, history and series, and that the SDK sent stock algod nothing it doesn't serve.
// Usage: tsx examples/stock.ts [upstream, default https://mainnet-api.algonode.cloud]
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { FutureRoundError, RetiGhostSDK, TimeTravelUnavailableError } from "../src"
import { REGISTRY_APP_ID } from "./common"
import { DEFAULT_UPSTREAM, startStockProxy } from "./stock-proxy"

const upstream = process.argv[2] ?? DEFAULT_UPSTREAM
const DESTROYED_ASSET = 1008695n // created at round 6,634,876, destroyed at 6,634,896
const USDC = 31566704n

const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))
let failures = 0
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
}
async function settle<T>(p: Promise<T>) {
  const start = Date.now()
  try {
    return { ok: true as const, value: await p, ms: Date.now() - start }
  } catch (error) {
    return { ok: false as const, error: error as Error, ms: Date.now() - start }
  }
}
const describe = (r: { ok: boolean; error?: Error }) =>
  r.ok ? "resolved" : `${r.error?.name}: ${String(r.error?.message).slice(0, 120)}`
const pointNames = (points: { round: bigint; ok: boolean; error?: Error }[]) =>
  points.map((p) => `${p.round}:${p.ok ? "ok" : p.error?.name}`).join(" ")

;(async () => {
  const proxy = await startStockProxy({ upstream })
  const url = new URL(proxy.url)
  const stockAlgorand = AlgorandClient.fromConfig({ algodConfig: { server: `${url.protocol}//${url.hostname}`, port: url.port } })
  const stock = new RetiGhostSDK({ algorand: stockAlgorand, registryAppId: REGISTRY_APP_ID })
  const direct = new RetiGhostSDK({
    algorand: AlgorandClient.fromConfig({ algodConfig: { server: upstream } }),
    registryAppId: REGISTRY_APP_ID,
  })
  // the generated SDK logs every chunk's ids
  const log = console.log
  console.log = (...args: unknown[]) => (String(args[0]).startsWith("[Ghostkit]") ? undefined : log(...args))

  // the same read on stock and on the upstream directly, compared
  async function same(label: string, read: (sdk: RetiGhostSDK) => Promise<unknown>) {
    const [a, b] = await Promise.all([settle(read(stock)), settle(read(direct))])
    if (!a.ok) return check(`${label} on stock`, false, describe(a))
    check(`${label} matches the upstream`, b.ok && ser(a.value) === ser(b.value), b.ok ? `${a.ms} ms` : describe(b))
  }

  try {
    // 1. detection
    const node = await stock.getNode()
    check("detected as stock", node.kind === "stock", node.kind === "stock" ? node.reason : node.kind)
    check("supportsTimeTravel() is false", (await stock.supportsTimeTravel()) === false)
    check("getMaxRounds() is 0", (await stock.getMaxRounds()) === 0)

    // 2. latest-state reads
    const ids = Array.from({ length: await stock.getNumValidators() }, (_, i) => i + 1)
    await same("getNumValidators", (s) => s.getNumValidators())
    await same("getMbrAmountsAndProtocolConstraints", (s) => s.getMbrAmountsAndProtocolConstraints())
    await same(`getValidatorConfig (${ids.length})`, (s) => s.getValidatorConfig(ids))
    await same("getValidatorStates", (s) => s.getValidatorStates(ids))
    await same("getPools", (s) => s.getPools(ids))
    await same("getNodePoolAssignments", (s) => s.getNodePoolAssignments(ids))
    await same("getValidators", (s) => s.getValidators(ids))
    await same("getAllValidators", (s) => s.getAllValidators())
    await same("getRegistryTotals", (s) => s.getRegistryTotals())
    await same("getValidatorTotals (first 20)", (s) => s.getValidatorTotals(ids.slice(0, 20)))

    const pools = (await stock.getPools(ids)).flat().map((p) => p.poolAppId)
    await same(`getPoolAlgodVersions (${pools.length})`, (s) => s.getPoolAlgodVersions(pools))
    await same("getPoolBalancesAndLastPayouts", (s) => s.getPoolBalancesAndLastPayouts(pools))
    await same("getPoolStates (first 30)", (s) => s.getPoolStates(pools.slice(0, 30)))
    await same("getPoolTotals (first 30)", (s) => s.getPoolTotals(pools.slice(0, 30)))
    await same("getPoolStakers (first pool)", (s) => s.getPoolStakers(pools[0]))
    await same("getPoolsStakers (first 10)", (s) => s.getPoolsStakers(pools.slice(0, 10)))

    const stakers = [...new Set((await stock.getPoolsStakers(pools.slice(0, 10))).flat().map((s) => s.account))].slice(0, 20)
    const tokens = [...new Set((await stock.getValidatorConfig(ids)).map((c) => c.rewardTokenId).filter((t) => t > 0n))]
    await same(`getStakerPositions (${stakers.length})`, (s) => s.getStakerPositions(stakers))
    await same("getAccountBalances", (s) => s.getAccountBalances(stakers))
    await same("getAssetHoldings", (s) =>
      s.getAssetHoldings(stakers.slice(0, 5).map((account) => ({ account, assetId: tokens[0] ?? USDC }))),
    )
    await same(`getAssets (${tokens.length} reward tokens, a destroyed asset)`, (s) => s.getAssets([...tokens, DESTROYED_ASSET]))
    await same("getBlockTimestamps(5)", (s) => s.getBlockTimestamps(5))

    // 3. rounds
    const { lastRound } = await stockAlgorand.client.algod.status().do()
    const near = await settle(stock.getValidators([1, 2], { round: lastRound - 5n }))
    check("5 rounds back reads the latest state", near.ok, describe(near))
    const back = await settle(stock.getValidators([1], { round: lastRound - 100n }))
    check("100 rounds back: TimeTravelUnavailableError", !back.ok && back.error instanceof TimeTravelUnavailableError, `${describe(back)} (${back.ms} ms)`)
    const old = await settle(stock.getPools([1], { round: 50_000_000n }))
    check("round 50,000,000: TimeTravelUnavailableError", !old.ok && old.error instanceof TimeTravelUnavailableError, `${old.ms} ms`)
    const future = await settle(stock.getValidators([1], { round: lastRound + 1000n }))
    check("a future round: FutureRoundError", !future.ok && future.error instanceof FutureRoundError, `${describe(future)} (${future.ms} ms)`)
    const stakersOld = await settle(stock.getPoolStakers(pools[0], { round: lastRound - 1000n }))
    check("getPoolStakers 1,000 rounds back: TimeTravelUnavailableError", !stakersOld.ok && stakersOld.error instanceof TimeTravelUnavailableError, describe(stakersOld))

    // 4. Date → round
    const ts = await settle(stock.getTimestampsAtRounds([50_000_000n, lastRound - 200n, lastRound - 3n, lastRound + 500n]))
    check(
      "getTimestampsAtRounds: old rounds TimeTravelUnavailableError, recent ok, future FutureRoundError",
      ts.ok && pointNames(ts.value).replace(/\d+:/g, "") === "TimeTravelUnavailableError TimeTravelUnavailableError ok FutureRoundError",
      ts.ok ? `${pointNames(ts.value)} (${ts.ms} ms)` : describe(ts),
    )
    const now = Math.floor(Date.now() / 1000)
    const first = await settle(stock.firstRoundAtOrAfter(lastRound - 20n, now - 30))
    check("firstRoundAtOrAfter near the latest round", first.ok && first.value !== undefined, first.ok ? `${ser(first.value)} (${first.ms} ms)` : describe(first))
    const firstOld = await settle(stock.firstRoundAtOrAfter(50_000_000n, now - 86400 * 365))
    check("firstRoundAtOrAfter at round 50,000,000: TimeTravelUnavailableError", !firstOld.ok && firstOld.error instanceof TimeTravelUnavailableError, `${describe(firstOld)} (${firstOld.ms} ms)`)
    const yesterday = await settle(stock.roundAt(new Date(Date.now() - 86400_000)))
    check("roundAt(yesterday), from block headers", yesterday.ok, yesterday.ok ? ser(yesterday.value) : describe(yesterday))
    const tsOf = await settle(stock.timestampOf(lastRound - 2n))
    check("timestampOf a recent round", tsOf.ok, tsOf.ok ? String(tsOf.value) : describe(tsOf))

    // 5. history and series
    const changes = await settle(stock.getChangeRounds({ validator: 1 }))
    check("getChangeRounds throws", !changes.ok, describe(changes))
    const series = await settle(stock.getRegistryTotalsSeries([50_000_000n, lastRound - 2n, lastRound + 100n]))
    check(
      "getRegistryTotalsSeries: past TimeTravelUnavailableError, latest ok, future FutureRoundError",
      series.ok && pointNames(series.value).replace(/\d+:/g, "") === "TimeTravelUnavailableError ok FutureRoundError",
      series.ok ? pointNames(series.value) : describe(series),
    )

    // 6. what the SDK sent
    const denied = proxy.requests.filter((r) => r.denied && r.path !== "/v2/capabilities")
    check(`nothing stock algod refuses, beyond the capabilities check (${proxy.requests.length} requests)`, denied.length === 0, denied.map((r) => `${r.method} ${r.path}: ${r.denied}`).join("; "))
    const capabilities = proxy.requests.filter((r) => r.path === "/v2/capabilities").length
    check("one capabilities check", capabilities === 1, `${capabilities}`)
    const simulates = proxy.requests.filter((r) => r.simulate)
    const fields = [...new Set(simulates.flatMap((r) => r.simulate!.keys))].sort()
    log(`  ${simulates.length} simulates, fields: ${fields.join(", ")}`)
  } finally {
    console.log = log
    await proxy.close()
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed")
  process.exit(failures ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
