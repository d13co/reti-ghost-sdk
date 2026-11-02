import { describe, expect, it, vi } from "vitest"
import { RoundBatcher } from "../src/utils/batcher"

/** A loader that answers each key with `${key}@${round}`, recording its calls. */
function recordingLoader() {
  const calls: { keys: string[]; round: bigint | undefined }[] = []
  const loader = vi.fn(async (keys: string[], round: bigint | undefined) => {
    calls.push({ keys, round })
    return new Map(keys.map((key) => [key, `${key}@${round ?? "latest"}`]))
  })
  return { loader, calls }
}

describe("RoundBatcher", () => {
  it("loads keys asked for together at one round in one call, each key once", async () => {
    const { loader, calls } = recordingLoader()
    const batcher = new RoundBatcher(loader, 5)
    const values = await Promise.all([batcher.load("a", 10n), batcher.load("b", 10n), batcher.load("a", 10n)])
    expect(values).toEqual(["a@10", "b@10", "a@10"])
    expect(calls).toEqual([{ keys: ["a", "b"], round: 10n }])
  })

  it("keeps rounds, and the latest, apart", async () => {
    const { loader, calls } = recordingLoader()
    const batcher = new RoundBatcher(loader, 5)
    const values = await Promise.all([batcher.load("a", 10n), batcher.load("a", 20n), batcher.load("a", undefined)])
    expect(values).toEqual(["a@10", "a@20", "a@latest"])
    expect(calls.map((c) => c.round)).toEqual([10n, 20n, undefined])
  })

  it("starts a new batch after the window", async () => {
    const { loader, calls } = recordingLoader()
    const batcher = new RoundBatcher(loader, 5)
    await batcher.load("a", 10n)
    await batcher.load("b", 10n)
    expect(calls.map((c) => c.keys)).toEqual([["a"], ["b"]])
  })

  it("rejects only an aborted caller, and cancels the request once every caller aborted", async () => {
    const signals: AbortSignal[] = []
    const batcher = new RoundBatcher(async (keys: string[], _round, signal) => {
      signals.push(signal)
      return new Map(keys.map((key) => [key, key]))
    }, 5)
    const controller = new AbortController()
    const aborted = batcher.load("a", 1n, controller.signal)
    const kept = batcher.load("b", 1n)
    controller.abort(new Error("stop"))
    await expect(aborted).rejects.toThrow("stop")
    await expect(kept).resolves.toBe("b")
    expect(signals[0].aborted).toBe(false)

    const one = new AbortController()
    const two = new AbortController()
    let seen: AbortSignal | undefined
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const slow = new RoundBatcher(async (keys: string[], _round, signal) => {
      seen = signal
      await blocked
      return new Map(keys.map((key) => [key, key]))
    }, 1)
    const p1 = slow.load("a", 1n, one.signal)
    const p2 = slow.load("b", 1n, two.signal)
    await new Promise((resolve) => setTimeout(resolve, 5))
    one.abort(new Error("one"))
    expect(seen!.aborted).toBe(false)
    two.abort(new Error("two"))
    expect(seen!.aborted).toBe(true)
    release()
    await expect(p1).rejects.toThrow("one")
    await expect(p2).rejects.toThrow("two")
  })

  it("rejects without loading when the signal has already aborted", async () => {
    const { loader } = recordingLoader()
    const batcher = new RoundBatcher(loader, 5)
    const controller = new AbortController()
    controller.abort(new Error("before"))
    expect(() => batcher.load("a", 1n, controller.signal)).toThrow("before")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(loader).not.toHaveBeenCalled()
  })

  it("rejects every caller when the load fails, and a key the load left out", async () => {
    const failing = new RoundBatcher<string, string>(async () => {
      throw new Error("node down")
    }, 5)
    const results = await Promise.allSettled([failing.load("a", 1n), failing.load("b", 1n)])
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"])

    const partial = new RoundBatcher<string, string>(async () => new Map([["a", "a"]]), 5)
    const [a, b] = await Promise.allSettled([partial.load("a", 1n), partial.load("b", 1n)])
    expect(a).toEqual({ status: "fulfilled", value: "a" })
    expect(b.status).toBe("rejected")
  })
})
