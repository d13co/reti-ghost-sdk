// Reads through read-only queries (backend `auto`) against the same reads through the extended simulate (backend `dt`),
// on two AlgorandClients: every decoded value must match, at the latest round, rounds spread over the registry's life,
// and in series and multi-round reads. Also checks the request pattern: on a node with queries, `auto` queries and
// reads no suggested params; on a node without, nothing queries (the simulate fallback). Prints each read's time on
// both paths. Each check prints PASS or FAIL, and the script exits 1 on any failure.
// Usage: tsx examples/query-vs-simulate.ts [series points, default 64]
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

const points = Number(process.argv[2] ?? 64)

// Count requests per path and their response bytes, by which SDK is reading (`phase`)
type Tally = { requests: number; bytes: number }
const tallies = new Map<string, Map<string, Tally>>()
let phase = ""
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname.replace(/\d{5,}/g, "N")
  const byPath = tallies.get(phase) ?? new Map<string, Tally>()
  tallies.set(phase, byPath)
  const tally = byPath.get(path) ?? { requests: 0, bytes: 0 }
  byPath.set(path, tally)
  tally.requests++
  const response = await realFetch(input, init)
  void response
    .clone()
    .arrayBuffer()
    .then((b) => (tally.bytes += b.byteLength), () => {})
  return response
}) as typeof fetch
const requestsTo = (ph: string, path: string) => tallies.get(ph)?.get(path)?.requests ?? 0
const bytesOf = (ph: string) => [...(tallies.get(ph)?.values() ?? [])].reduce((sum, t) => sum + t.bytes, 0)

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
}

/** Bigint-, bytes- and error-aware JSON, so results compare as strings. */
const serialize = (value: unknown) =>
  JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v instanceof Error ? `${v.name}: ${v.message}` : v,
  )

/** Runs a read, returning its serialized result (or error) and how long it took. */
async function run(ph: string, read: () => Promise<unknown>): Promise<{ out: string; ms: number; failed: boolean }> {
  phase = ph
  const start = performance.now()
  try {
    const value = await read()
    return { out: serialize(value), ms: performance.now() - start, failed: false }
  } catch (e) {
    return { out: serialize(e instanceof Error ? e : new Error(String(e))), ms: performance.now() - start, failed: true }
  } finally {
    phase = ""
  }
}

;(async () => {
  const auto = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })
  const dt = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID, backend: "dt" })

  phase = "auto:warm"
  const node = await auto.getNode()
  await auto.prefetch()
  phase = "dt:warm"
  await dt.prefetch()
  phase = ""
  console.log("node:", serialize(node))
  if (node.kind !== "dt") throw new Error("not a dtalgorand node: point DT_ALGOD_SERVER at one")
  const queries = node.query !== undefined
  console.log(queries ? `node has queries: max-rounds ${node.query!.maxRounds}, max-calls ${node.query!.maxCalls}` : "node has no queries: checking the simulate fallback")
  check(
    "prefetch: suggested params only without queries",
    (requestsTo("auto:warm", "/v2/transactions/params") === 0) === queries,
    `${requestsTo("auto:warm", "/v2/transactions/params")} params reads`,
  )

  const created = (await dt.getRegistryCreationRound())!
  const { round: latest } = await dt.clock.latest()
  const span = latest - 1_000n - (created + 1_000n)
  const rounds: (bigint | undefined)[] = [undefined, created + 1_000n, created + 1_000n + span / 3n, created + 1_000n + (2n * span) / 3n, latest - 1_000n]

  /** Compares a read on both SDKs; a read of the latest state is retried if a block may have landed in between. */
  const compare = async (label: string, read: (sdk: RetiGhostSDK) => Promise<unknown>, atLatest: boolean) => {
    for (let attempt = 1; ; attempt++) {
      const s = await run("dt", () => read(dt))
      const q = await run("auto", () => read(auto))
      const equal = q.out === s.out
      if (!equal && atLatest && attempt < 3) continue
      const timing = `query ${q.ms.toFixed(0)}ms, simulate ${s.ms.toFixed(0)}ms${attempt > 1 ? ` (attempt ${attempt})` : ""}${q.failed ? `, both fail: ${q.out.slice(0, 120)}` : ""}`
      let detail = timing
      if (!equal) {
        let i = 0
        while (i < q.out.length && q.out[i] === s.out[i]) i++
        detail += `\n    auto: …${q.out.slice(Math.max(0, i - 80), i + 120)}\n    dt:   …${s.out.slice(Math.max(0, i - 80), i + 120)}`
      }
      check(label, equal, detail)
      return
    }
  }

  for (const round of rounds) {
    const at = round === undefined ? "latest" : `round ${round}`
    const options = round === undefined ? {} : { round }
    const n = await dt.getNumValidators(options)
    const ids = Array.from({ length: n }, (_, i) => i + 1)
    const pools = (await dt.getPools(ids, options)).flat().map((p) => p.poolAppId)
    const stakers = pools.length > 0 ? (await dt.getPoolStakers(pools[0], options)).slice(0, 50).map((s) => s.account) : []
    const reads: [string, (sdk: RetiGhostSDK) => Promise<unknown>][] = [
      ["getMbrAmountsAndProtocolConstraints", (x) => x.getMbrAmountsAndProtocolConstraints(options)],
      [`getValidators(${ids.length})`, (x) => x.getValidators(ids, options)],
      [`getValidatorConfig(${ids.length})`, (x) => x.getValidatorConfig(ids, options)],
      [`getPools(${ids.length})`, (x) => x.getPools(ids, options)],
      [`getPoolStates(${pools.length})`, (x) => x.getPoolStates(pools, options)],
      [`getPoolBalancesAndLastPayouts(${pools.length})`, (x) => x.getPoolBalancesAndLastPayouts(pools, options)],
      [`getPoolAlgodVersions(${pools.length})`, (x) => x.getPoolAlgodVersions(pools, options)],
      // a pool id past the newest app reads as zeros (the reader's `id >= currentApplicationId` check)
      ["getPoolTotals (incl. a missing pool)", (x) => x.getPoolTotals([...pools.slice(-1), 99_999_999_999n], options)],
      [`getStakerPositions(${stakers.length})`, (x) => x.getStakerPositions(stakers, options)],
      [`getAccountBalances(${stakers.length})`, (x) => x.getAccountBalances(stakers, options)],
      ["getAssetHoldings", (x) => x.getAssetHoldings(stakers.slice(0, 3).map((account) => ({ account, assetId: 31566704n })), options)],
      ["getAssets (incl. a missing asset)", (x) => x.getAssets([31566704n, 1000n, 2537013734n], options)],
      ["getBlockTimestamps(1000)", (x) => x.getBlockTimestamps(1000, options)],
    ]
    for (const [name, read] of reads) await compare(`${at}: ${name}`, read, round === undefined)
  }

  const n = await dt.getNumValidators({ round: latest })
  const ids = Array.from({ length: n }, (_, i) => i + 1)
  const series = { from: created, to: latest, points }
  const tsRounds = Array.from({ length: 16 }, (_, i) => created + 1n + ((latest - created - 1n) * BigInt(i)) / 15n)
  const multi: [string, (sdk: RetiGhostSDK) => Promise<unknown>][] = [
    [`getValidatorTotalsSeries(${ids.length} × ${points})`, (x) => x.getValidatorTotalsSeries(ids, series)],
    // a round before the registry and one past the latest fail as points, alike on both paths
    ["getRegistryTotalsSeries (incl. pre-creation and future rounds)", (x) => x.getRegistryTotalsSeries([created - 1n, created, latest, latest + 50n])],
    ["getTimestampsAtRounds(16)", (x) => x.getTimestampsAtRounds(tsRounds)],
    ["firstRoundAtOrAfter mid-history", (x) => x.firstRoundAtOrAfter(60_000_000n, 1_760_000_000, { knownRound: latest })],
    ["firstRoundAtOrAfter near the tip", (x) => x.firstRoundAtOrAfter(latest - 200n, Date.now() / 1000 + 3600, { knownRound: latest })],
  ]
  for (const [name, read] of multi) {
    const before = { auto: bytesOf("auto"), dt: bytesOf("dt") }
    await compare(name, read, false)
    await new Promise((r) => setTimeout(r, 50)) // let the byte counts settle
    const mb = (ph: "auto" | "dt") => ((bytesOf(ph) - before[ph]) / 1e6).toFixed(2)
    console.log(`    responses: auto ${mb("auto")} MB, dt ${mb("dt")} MB`)
  }

  // request pattern
  const autoQueries = requestsTo("auto", "/v2/query") + requestsTo("auto:warm", "/v2/query")
  const dtQueries = requestsTo("dt", "/v2/query") + requestsTo("dt:warm", "/v2/query")
  if (queries) {
    check("auto queries", autoQueries > 0, `${autoQueries} queries, ${requestsTo("auto", "/v2/transactions/simulate")} simulates`)
    check("auto reads no suggested params", requestsTo("auto", "/v2/transactions/params") === 0, `${requestsTo("auto", "/v2/transactions/params")} reads`)
  } else {
    check("auto falls back to simulate (no queries sent)", autoQueries === 0, `${autoQueries} queries`)
  }
  check("dt never queries", dtQueries === 0, `${dtQueries} queries`)
  for (const ph of ["auto", "dt"]) {
    const byPath = [...(tallies.get(ph) ?? new Map<string, Tally>())].map(([path, t]) => `${path} ×${t.requests}`)
    console.log(`requests (${ph}): ${byPath.join(", ")}`)
  }

  console.log(failures ? `${failures} failed` : "all passed")
  process.exit(failures ? 1 : 0)
})()
