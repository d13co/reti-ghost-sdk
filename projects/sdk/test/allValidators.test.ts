import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { describe, expect, it, vi } from "vitest"
import { RetiGhostSDK } from "../src/index.js"

const REGISTRY = 2714516089n

/** A validator as the reader returns it: only `config.id` matters here; ids past the count read as 0. */
const validator = (id: bigint, count: number) => ({ config: { id: id <= BigInt(count) ? id : 0n } })

/** An SDK whose reads go to a fake reader over a registry of `count` validators. */
function fakeSdk(count: { value: number }) {
  const getValidators = vi.fn(async ({ methodArgsOrArgsArray }: { methodArgsOrArgsArray: { validatorIds: bigint[] } }) =>
    methodArgsOrArgsArray.validatorIds.map((id) => validator(id, count.value)),
  )
  const getRegistryTotals = vi.fn(async () => [{ numValidators: BigInt(count.value), numStakers: 0n, staked: 0n }])
  const reader = { getValidators, getRegistryTotals }
  const batch = vi.fn(async (fn: (s: typeof reader) => Promise<unknown>[]) => Promise.all(fn(reader)))
  const sdk = new RetiGhostSDK({ algorand: AlgorandClient.defaultLocalNet(), registryAppId: REGISTRY })
  // every read goes to the fake reader, at whatever round
  ;(sdk as unknown as { read: unknown }).read = (_: unknown, call: (r: unknown) => Promise<unknown>) => call({ ...reader, batch })
  const idsRead = (call: number) => getValidators.mock.calls[call][0].methodArgsOrArgsArray.validatorIds
  return { sdk, batch, getValidators, getRegistryTotals, idsRead }
}

describe("getAllValidators", () => {
  it("reads the count and validators 1..256 in one batch, and keeps the first `count`", async () => {
    const { sdk, batch, getValidators, getRegistryTotals, idsRead } = fakeSdk({ value: 227 })
    const validators = await sdk.getAllValidators()
    expect(batch).toHaveBeenCalledTimes(1)
    expect(getRegistryTotals).toHaveBeenCalledTimes(1)
    expect(getValidators).toHaveBeenCalledTimes(1)
    expect(idsRead(0)).toEqual(Array.from({ length: 256 }, (_, i) => BigInt(i + 1)))
    expect(validators.map((v) => v.config.id)).toEqual(Array.from({ length: 227 }, (_, i) => BigInt(i + 1)))
  })

  it("returns nothing for a registry with no validators", async () => {
    const { sdk } = fakeSdk({ value: 0 })
    expect(await sdk.getAllValidators()).toEqual([])
  })

  it("reads the rest in a second request when the registry outgrew the guess, then guesses from the count", async () => {
    const count = { value: 300 }
    const { sdk, batch, getValidators, idsRead } = fakeSdk(count)
    const validators = await sdk.getAllValidators()
    expect(batch).toHaveBeenCalledTimes(1)
    expect(getValidators).toHaveBeenCalledTimes(2)
    expect(idsRead(1)).toEqual(Array.from({ length: 44 }, (_, i) => BigInt(257 + i)))
    expect(validators.map((v) => v.config.id)).toEqual(Array.from({ length: 300 }, (_, i) => BigInt(i + 1)))

    // 300 seen, plus headroom, rounded up to a whole group of 64: one request again
    count.value = 310
    expect(await sdk.getAllValidators()).toHaveLength(310)
    expect(getValidators).toHaveBeenCalledTimes(3)
    expect(idsRead(2)).toHaveLength(320)
  })

  it("shares what it has seen with atRound views, and takes expectedCount", async () => {
    const { sdk, idsRead } = fakeSdk({ value: 400 })
    await sdk.getAllValidators()
    await sdk.atRound(50_000_000n).getAllValidators()
    expect(idsRead(2)).toHaveLength(448)

    const other = fakeSdk({ value: 10 })
    await other.sdk.getAllValidators({ expectedCount: 500 })
    expect(other.idsRead(0)).toHaveLength(576)
  })
})

describe("prefetch", () => {
  it("reads the latest round, so a time-travel read at or below it needs no status read", async () => {
    const sdk = new RetiGhostSDK({ algorand: AlgorandClient.defaultLocalNet(), registryAppId: REGISTRY })
    const status = vi.fn(() => ({ do: async () => ({ lastRound: 1_000n }) }))
    ;(sdk.algorand.client.algod as unknown as { status: unknown }).status = status
    vi.spyOn(sdk.ghost, "prefetch").mockResolvedValue()
    vi.spyOn(sdk, "getRegistryCreationRound").mockResolvedValue(10n)
    vi.spyOn(sdk, "getNode").mockResolvedValue({ kind: "dt", limits: { timeTravel: true } } as Awaited<ReturnType<typeof sdk.getNode>>)
    const plan = (round: bigint) => (sdk as unknown as { planRounds(r: bigint[]): Promise<unknown[]> }).planRounds([round])

    await sdk.prefetch()
    expect(status).toHaveBeenCalledTimes(1)

    expect(await plan(500n)).toEqual([{ round: 500n, at: 500n }])
    expect(await plan(1_000n)).toEqual([{ round: 1_000n, at: 1_000n }])
    expect(status).toHaveBeenCalledTimes(1)

    // a round past the latest seen still asks the node
    await plan(1_001n).catch(() => {})
    expect(status).toHaveBeenCalledTimes(2)
  })
})
