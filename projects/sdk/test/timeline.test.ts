import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { describe, expect, it, vi } from "vitest"
import { uint64BoxName } from "../src/decode.js"
import { isDTUnsupported } from "../src/errors.js"
import { getChangeRounds, stakerPoolSetBoxName } from "../src/history/timeline.js"

const REGISTRY = 760937186n
const STAKER = "7Z5PWO2C6LFNQFGHWKSK5H47IQP5OJW2M3HA2QPXTY3WTNP5NU2MHBW27M"

function fakeDT() {
  const page = { versions: [{ round: 10n, timestamp: 1_700_000_000, deleted: false, value: new Uint8Array() }], nextToken: "n" }
  const dt = { getAppVersions: vi.fn(async () => page), getBoxVersions: vi.fn(async () => page) }
  return { dt, algorand: { dt } as unknown as AlgorandClient }
}

describe("getChangeRounds", () => {
  it("throws a DT-unsupported error with stock algokit-utils (no algorand.dt)", async () => {
    const e = await getChangeRounds({} as AlgorandClient, REGISTRY, { registry: true }).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).name).toBe("DTNotAvailableError")
    expect(isDTUnsupported(e)).toBe(true)
  })

  it("lists each target's versions, rounds only", async () => {
    const { dt, algorand } = fakeDT()
    const options = { minRound: 5, maxRound: 20n, order: "asc" as const, limit: 10 }
    const expected = { minRound: 5n, maxRound: 20n, limit: 10, order: "asc" }

    const page = await getChangeRounds(algorand, REGISTRY, { registry: true }, options)
    expect(page).toEqual({ changes: [{ round: 10n, timestamp: 1_700_000_000, deleted: false }], next: "n" })
    expect(dt.getAppVersions).toHaveBeenLastCalledWith(REGISTRY, expected)

    await getChangeRounds(algorand, REGISTRY, { pool: 42 }, options)
    expect(dt.getAppVersions).toHaveBeenLastCalledWith(42n, expected)

    await getChangeRounds(algorand, REGISTRY, { validator: 3 }, options)
    expect(dt.getBoxVersions).toHaveBeenLastCalledWith(REGISTRY, uint64BoxName("v", 3), expected)

    await getChangeRounds(algorand, REGISTRY, { poolStakers: 42n }, options)
    expect(dt.getBoxVersions).toHaveBeenLastCalledWith(42n, "stakers", expected)

    await getChangeRounds(algorand, REGISTRY, { staker: STAKER }, options)
    expect(dt.getBoxVersions).toHaveBeenLastCalledWith(REGISTRY, stakerPoolSetBoxName(STAKER), expected)
  })
})
