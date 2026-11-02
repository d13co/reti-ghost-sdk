// Reads every pool's stakers through the query reader (one batched query per round) and through one REST box read per
// pool, at the latest round and rounds spread over the registry's life, and checks every list matches. Also checks
// that `getPoolStakers` calls made together coalesce into one query, and prints each path's time and requests.
// Each check prints PASS or FAIL, and the script exits 1 on any failure.
// Usage: DT_ALGOD_SERVER=http://localhost:8080 tsx examples/pool-stakers.ts [rounds, default 4]
import { RetiGhostSDK, type PoolStaker } from "../src"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

const extraRounds = Number(process.argv[2] ?? 4)

// Count requests per path
const requests = new Map<string, number>()
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname.replace(/\d{5,}/g, "N")
  requests.set(path, (requests.get(path) ?? 0) + 1)
  return realFetch(input, init)
}) as typeof fetch
const snapshot = () => new Map(requests)
const since = (before: Map<string, number>) =>
  [...requests].flatMap(([path, n]) => (n - (before.get(path) ?? 0) > 0 ? [`${path}×${n - (before.get(path) ?? 0)}`] : [])).join(" ")

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
}
const serialize = (lists: PoolStaker[][]) => JSON.stringify(lists, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))

;(async () => {
  const algorand = dtAlgorand()
  const sdk = new RetiGhostSDK({ algorand, registryAppId: REGISTRY_APP_ID })
  // reads through the extended simulate, never queries: the REST box reads of a node without queries
  const restSdk = new RetiGhostSDK({ algorand, registryAppId: REGISTRY_APP_ID, backend: "dt" })
  const node = await sdk.getNode()
  if (node.kind !== "dt" || !node.query) throw new Error("this needs a dtalgorand node with queries")
  const latest = (await algorand.client.algod.status().do()).lastRound
  const creation = (await sdk.getRegistryCreationRound()) ?? latest - 10_000_000n
  const rounds: (bigint | undefined)[] = [undefined]
  for (let i = 1; i <= extraRounds; i++) rounds.push(creation + ((latest - creation) * BigInt(i)) / BigInt(extraRounds + 1))

  for (const round of rounds) {
    const at = round === undefined ? "latest" : `round ${round}`
    const pinned = round === undefined ? latest : round
    const validators = await sdk.getAllValidators({ round: pinned })
    const pools = validators.flatMap((v) => v.poolInfo.map(([poolAppId]) => poolAppId).filter((id) => id > 0n))

    let before = snapshot()
    let start = performance.now()
    const queried = await sdk.getPoolsStakers(pools, { round: pinned })
    const queryMs = performance.now() - start
    const queryRequests = since(before)

    before = snapshot()
    start = performance.now()
    const rest = await restSdk.getPoolsStakers(pools, { round: pinned })
    const restMs = performance.now() - start
    const restRequests = since(before)

    const stakers = queried.reduce((n, list) => n + list.length, 0)
    check(`${at}: ${pools.length} pools, ${stakers} stakers, query = REST`, serialize(queried) === serialize(rest))
    console.log(`  query ${queryMs.toFixed(0)} ms [${queryRequests}]  REST ${restMs.toFixed(0)} ms [${restRequests}]`)
  }

  // single-pool calls made together go out as one query
  const validators = await sdk.getAllValidators({ round: latest })
  const pools = validators.flatMap((v) => v.poolInfo.map(([poolAppId]) => poolAppId).filter((id) => id > 0n)).slice(0, 40)
  const before = snapshot()
  const singles = await Promise.all(pools.map((pool) => sdk.getPoolStakers(pool, { round: latest })))
  const bulk = await sdk.getPoolsStakers(pools, { round: latest })
  const queries = (requests.get("/v2/query") ?? 0) - (before.get("/v2/query") ?? 0)
  check(`${pools.length} getPoolStakers calls coalesce`, queries === 2, `${queries} queries for them and the bulk read`)
  check("coalesced calls = bulk read", serialize(singles) === serialize(bulk))

  // without queries, single calls are read together too: one REST box read per pool, none twice
  const restBefore = snapshot()
  const restSingles = await Promise.all([...pools, pools[0]].map((pool) => restSdk.getPoolStakers(pool, { round: latest })))
  const boxReads = (requests.get("/v2/applications/N/box") ?? 0) - (restBefore.get("/v2/applications/N/box") ?? 0)
  const restQueries = (requests.get("/v2/query") ?? 0) - (restBefore.get("/v2/query") ?? 0)
  check(`without queries, ${pools.length + 1} calls read ${pools.length} boxes`, boxReads === pools.length && restQueries === 0, `${boxReads} box reads, ${restQueries} queries`)
  check("REST single calls = bulk read", serialize(restSingles.slice(0, -1)) === serialize(bulk))

  // an aborted caller rejects alone; the others in its batch still get their stakers
  const controller = new AbortController()
  const aborted = sdk.getPoolStakers(pools[0], { round: latest, signal: controller.signal })
  const other = sdk.getPoolStakers(pools[1], { round: latest })
  controller.abort()
  const [a, b] = await Promise.allSettled([aborted, other])
  check("an abort rejects only its own call", a.status === "rejected" && b.status === "fulfilled")

  // a pool that doesn't exist reads as no stakers
  const [none] = await sdk.getPoolsStakers([1n], { round: latest })
  check("a missing app has no stakers", none.length === 0)

  process.exit(failures ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
