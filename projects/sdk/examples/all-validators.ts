// getAllValidators (count and validators in one batch) against getNumValidators + getValidators (two requests in a
// row): same validators at the latest round and rounds over the registry's life, request counts, and timings.
// Usage: DT_ALGOD_SERVER=http://localhost:8080 [RTT=40] tsx examples/all-validators.ts [warm runs, default 7]
// RTT adds that many ms before every request, to stand in for a remote node.
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

const WARM = Number(process.argv[2] ?? 7)
const RTT = Number(process.env.RTT ?? 0)
const ROUNDS: (bigint | undefined)[] = [undefined, 66_000_000n, 62_000_000n, 58_000_000n, 54_000_000n, 50_000_000n, 47_000_000n]

let requests = 0
let bytes = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++
  if (RTT) await new Promise((resolve) => setTimeout(resolve, RTT))
  const response = await realFetch(input, init)
  void response.clone().arrayBuffer().then((b) => (bytes += b.byteLength), () => {})
  return response
}) as typeof fetch

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++
  if (!ok || process.env.VERBOSE) console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
}

async function measure(fn: () => Promise<unknown>) {
  requests = 0
  bytes = 0
  const start = performance.now()
  await fn()
  const ms = performance.now() - start
  await new Promise((resolve) => setTimeout(resolve, 5)) // let byte counts land
  return { ms, requests, bytes }
}

const twoStep = async (sdk: RetiGhostSDK) => {
  const n = await sdk.getNumValidators()
  return sdk.getValidators(Array.from({ length: n }, (_, i) => i + 1))
}

;(async () => {
  const fresh = () => new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })
  const sdk = fresh()
  await sdk.prefetch()

  // a cold SDK (no count seen yet) still reads MainNet in one request
  const cold = fresh()
  await cold.prefetch()
  const first = await measure(() => cold.getAllValidators())
  check("cold SDK: getAllValidators is one request", first.requests === 1, `${first.requests} requests`)

  const rows: string[] = []
  for (const round of ROUNDS) {
    const at = sdk.atRound(round)
    const [a, b] = await Promise.all([twoStep(at), at.getAllValidators()])
    check(`@${round ?? "latest"}: same validators`, json(a) === json(b), `${a.length} vs ${b.length}`)

    const runs = { two: [] as Awaited<ReturnType<typeof measure>>[], one: [] as Awaited<ReturnType<typeof measure>>[] }
    for (let k = 0; k < WARM; k++) {
      const order = k % 2 ? (["one", "two"] as const) : (["two", "one"] as const)
      for (const which of order) runs[which].push(await measure(() => (which === "two" ? twoStep(at) : at.getAllValidators())))
    }
    check(`@${round ?? "latest"}: getAllValidators is one request`, runs.one[0].requests === 1)
    const row = (label: string, rs: typeof runs.one) =>
      `${String(round ?? "latest").padEnd(9)} ${String(b.length).padStart(4)}  ${label.padEnd(34)} ${median(rs.map((r) => r.ms)).toFixed(0).padStart(5)} ms  ${String(rs[0].requests).padStart(2)} req  ${(rs[0].bytes / 1e3).toFixed(0).padStart(5)} kB`
    rows.push(row("getNumValidators + getValidators", runs.two), row("getAllValidators", runs.one))
  }
  console.log(`\nRTT ${RTT} ms, median of ${WARM}; cold SDK first read ${first.ms.toFixed(0)} ms, ${first.requests} request`)
  console.log(`round     vals  read                                  time   reqs   bytes`)
  console.log(rows.join("\n"))
  console.log(failures ? `\n${failures} FAILED` : "\nall checks PASS")
  process.exit(failures ? 1 : 0)
})()
