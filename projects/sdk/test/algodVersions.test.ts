import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { describe, expect, it, vi } from "vitest"
import { isDTUnsupported } from "../src/errors.js"
import { getPoolAlgodVersionChanges } from "../src/history/algodVersions.js"

const POOL = 2714622967n
const bytes = (text: string) => {
  const valueRaw = new TextEncoder().encode(text)
  return { keyRaw: new TextEncoder().encode("algodVer"), keyBase64: "", valueRaw, valueBase64: "", value: text }
}
type Version = { round: bigint; timestamp: number; deleted: boolean; keyValue?: ReturnType<typeof bytes> | { value: bigint } }

/** An `algorand` whose `dt.iterateAppVersions` yields `versions`, or throws `error` after them. */
function fake(versions: Version[], error?: unknown) {
  const iterateAppVersions = vi.fn(async function* () {
    for (const v of versions) yield v
    if (error) throw error
  })
  return { iterateAppVersions, algorand: { dt: { iterateAppVersions } } as unknown as AlgorandClient }
}

describe("getPoolAlgodVersionChanges", () => {
  it("sends key=algodVer to the node, ascending, 1,000 per request, with the range and signal", async () => {
    const { iterateAppVersions, algorand } = fake([])
    const signal = new AbortController().signal
    await getPoolAlgodVersionChanges(algorand, Number(POOL), { minRound: 10, maxRound: 20n, signal })
    expect(iterateAppVersions).toHaveBeenCalledTimes(1)
    expect(iterateAppVersions).toHaveBeenCalledWith(POOL, { key: "algodVer", order: "asc", limit: 1000, minRound: 10n, maxRound: 20n, signal })

    await getPoolAlgodVersionChanges(algorand, POOL)
    expect(iterateAppVersions).toHaveBeenLastCalledWith(POOL, { key: "algodVer", order: "asc", limit: 1000 })
  })

  it("maps the key's bytes to text, and a removal or deletion to an empty string", async () => {
    const { algorand } = fake([
      { round: 100n, timestamp: 1, deleted: false, keyValue: bytes("4.0.1 rel/stable") },
      { round: 200n, timestamp: 2, deleted: false, keyValue: bytes("4.4.1 rel/stable") },
      { round: 300n, timestamp: 3, deleted: false },
      { round: 400n, timestamp: 4, deleted: false, keyValue: bytes("4.5.0 rel/stable") },
      { round: 500n, timestamp: 5, deleted: true },
    ])
    expect(await getPoolAlgodVersionChanges(algorand, POOL)).toEqual([
      { round: 100n, timestamp: 1, algodVer: "4.0.1 rel/stable" },
      { round: 200n, timestamp: 2, algodVer: "4.4.1 rel/stable" },
      { round: 300n, timestamp: 3, algodVer: "" },
      { round: 400n, timestamp: 4, algodVer: "4.5.0 rel/stable" },
      { round: 500n, timestamp: 5, algodVer: "" },
    ])
  })

  it("drops a repeat of the previous value", async () => {
    const { algorand } = fake([
      { round: 100n, timestamp: 1, deleted: false, keyValue: bytes("a") },
      { round: 150n, timestamp: 2, deleted: false, keyValue: bytes("a") },
      { round: 200n, timestamp: 3, deleted: false },
      { round: 250n, timestamp: 4, deleted: true },
    ])
    expect((await getPoolAlgodVersionChanges(algorand, POOL)).map((c) => [c.round, c.algodVer])).toEqual([
      [100n, "a"],
      [200n, ""],
    ])
  })

  it("passes the node's errors and an abort through unchanged", async () => {
    const unsupported = Object.assign(new Error("versions not supported"), { name: "DTUnsupportedError" })
    await expect(getPoolAlgodVersionChanges(fake([], unsupported).algorand, POOL)).rejects.toBe(unsupported)

    const controller = new AbortController()
    controller.abort()
    const { iterateAppVersions, algorand } = fake([{ round: 1n, timestamp: 1, deleted: false, keyValue: bytes("a") }], controller.signal.reason)
    await expect(getPoolAlgodVersionChanges(algorand, POOL, { signal: controller.signal })).rejects.toBe(controller.signal.reason)
    expect(iterateAppVersions.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
  })

  it("throws a DT-unsupported error with stock algokit-utils, sending nothing", async () => {
    const e = await getPoolAlgodVersionChanges({} as AlgorandClient, POOL).catch((e: unknown) => e)
    expect((e as Error).name).toBe("DTNotAvailableError")
    expect(isDTUnsupported(e)).toBe(true)
  })
})
