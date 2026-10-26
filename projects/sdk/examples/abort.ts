// Aborting reads with an AbortSignal: each check prints PASS or FAIL, and the script exits 1 on any failure.
// Usage: tsx examples/abort.ts
import { RetiGhostSDK } from "../src"
import { dtAlgorand, REGISTRY_APP_ID } from "./common"

// Count requests, and how many fetch saw cancelled. `abortOnRead` aborts once a simulate or query request is in flight.
const requests: { url: string; cancelled: boolean }[] = []
let abortOnRead: AbortController | undefined
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const entry = { url: String(input instanceof Request ? input.url : input), cancelled: false }
  requests.push(entry)
  if (abortOnRead && /\/v2\/(transactions\/simulate|query)(\?|$)/.test(entry.url)) {
    const controller = abortOnRead
    abortOnRead = undefined
    setTimeout(() => controller.abort(), 1)
  }
  try {
    return await realFetch(input, init)
  } catch (e) {
    if ((e as Error)?.name === "AbortError") entry.cancelled = true
    throw e
  }
}) as typeof fetch

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
}
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError"
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const sdk = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID })
  // warm the shared reads (node, creation round, status) so the checks below only count their own requests
  const creation = (await sdk.getRegistryCreationRound())!
  const { round: latest } = await sdk.clock.latest()
  const pinned = latest - 100_000n

  // 1. An aborted series read rejects with the abort, not with failed points, and sends nothing more
  {
    const controller = new AbortController()
    const before = requests.length
    abortOnRead = controller
    const series = settle(sdk.getRegistryTotalsSeries({ from: creation + 1_000n, to: latest, points: 64 }, { signal: controller.signal }))
    const result = await series
    const own = requests.slice(before)
    check("series: rejects with AbortError", !result.ok && isAbort(result.error), result.ok ? `resolved with ${result.value.length} points` : String(result.error))
    check("series: its request was cancelled", own.some((r) => r.cancelled), `${own.length} requests`)
    const sent = requests.length
    await sleep(500)
    check("series: no request after the abort", requests.length === sent, `${requests.length - sent} more`)
  }

  // 2. An aborted pinned read cancels its query or simulate
  {
    const controller = new AbortController()
    const before = requests.length
    abortOnRead = controller
    const read = settle(sdk.getValidators([1, 2, 3], { round: pinned, signal: controller.signal }))
    const result = await read
    check("pinned read: rejects with AbortError", !result.ok && isAbort(result.error), result.ok ? "resolved" : String(result.error))
    check("pinned read: its request was cancelled", requests.slice(before).some((r) => r.cancelled))
  }

  // 3. A signal that is already aborted sends nothing
  {
    const controller = new AbortController()
    controller.abort()
    const before = requests.length
    const result = await settle(sdk.getPoolStakers(1, { signal: controller.signal }))
    check("pre-aborted: rejects with AbortError", !result.ok && isAbort(result.error))
    check("pre-aborted: no request", requests.length === before)
  }

  // 4. roundAt aborted between probes reads no more headers
  {
    const controller = new AbortController()
    const probes: bigint[] = []
    let abortedAt = -1
    const lookup = settle(
      sdk.roundAt(new Date(Date.now() - 200 * 86_400_000), {
        signal: controller.signal,
        onProbe: (round) => {
          probes.push(round)
          if (probes.length === 2) {
            controller.abort()
            abortedAt = probes.length
          }
        },
      }),
    )
    const result = await lookup
    await sleep(300)
    check("roundAt: rejects with AbortError", !result.ok && isAbort(result.error), result.ok ? `resolved at ${result.value.round}` : String(result.error))
    check("roundAt: no probe after the abort", probes.length === abortedAt, `${probes.length} probes, aborted after ${abortedAt}`)
  }

  // 5. A cached header read shared with another caller still resolves for it when one caller aborts
  {
    const round = latest - 12_345n
    const controller = new AbortController()
    const shared = settle(sdk.timestampOf(round))
    const mine = settle(sdk.timestampOf(round, { signal: controller.signal }))
    controller.abort()
    const [a, b] = await Promise.all([shared, mine])
    check("shared header: the aborted caller rejects", !b.ok && isAbort(b.error))
    check("shared header: the other caller resolves", a.ok && typeof a.value === "number", a.ok ? String(a.value) : String(a.error))
  }

  // 6. On the stock backend (one simulate per group), an abort still surfaces as the abort, not a GhostkitError
  {
    const stock = new RetiGhostSDK({ algorand: dtAlgorand(), registryAppId: REGISTRY_APP_ID, backend: "stock" })
    await stock.getNode()
    const controller = new AbortController()
    abortOnRead = controller
    const read = settle(stock.getValidators([1, 2, 3], { signal: controller.signal }))
    const result = await read
    check("stock backend: rejects with AbortError", !result.ok && isAbort(result.error), result.ok ? "resolved" : String(result.error))
  }

  // 7. Without a signal, reads still work
  {
    const [v] = await sdk.getValidators([1], { round: pinned })
    check("no signal: pinned read works", v.config.id === 1n)
  }

  console.log(failures ? `${failures} failed` : "all passed")
  process.exit(failures ? 1 : 0)
})()
