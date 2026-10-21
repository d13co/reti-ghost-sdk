import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { raceAbort } from "../abort.js"

/** A round and its block's timestamp, in seconds since the epoch. */
export type RoundTime = { round: bigint; timestamp: number }

/** Options for `RoundClock.roundAt`. */
export type RoundAtOptions = {
  /** The earliest round to return (default 1) */
  minRound?: number | bigint
  /** Return `minRound` for a time before it, instead of throwing a `RangeError` */
  clamp?: boolean
  /** Called with each round read, e.g. to count requests */
  onProbe?: (round: bigint) => void
  /**
   * Aborts the lookup between header reads. Header reads are cached and shared, so they aren't cancelled: the lookup
   * stops waiting for them and reads no more.
   */
  signal?: AbortSignal
}

/** Most header reads one lookup may take before giving up; a lookup normally takes under 10. */
const MAX_PROBES = 64
/** Rounds read on each side of the estimate once it's close. */
const WINDOW = 3n

/**
 * Maps between rounds and block timestamps by reading block headers, which a dtalgorand node serves for any round.
 * Headers are cached, since a past header never changes.
 */
export class RoundClock {
  private headers = new Map<bigint, Promise<number>>()

  constructor(private algorand: AlgorandClient) {}

  /** The timestamp of a round's block, in seconds since the epoch. */
  timestampOf(round: number | bigint): Promise<number> {
    const r = BigInt(round)
    let ts = this.headers.get(r)
    if (!ts) {
      ts = this.algorand.client.algod
        .block(r)
        .headerOnly(true)
        .do()
        .then(({ block }) => Number(block.header.timestamp))
      ts.catch(() => this.headers.delete(r))
      this.headers.set(r, ts)
    }
    return ts
  }

  /** Caches a round's timestamp that was read some other way, e.g. by a simulate. */
  remember(round: number | bigint, timestamp: number): void {
    const r = BigInt(round)
    if (!this.headers.has(r)) this.headers.set(r, Promise.resolve(timestamp))
  }

  /** The node's latest round and its timestamp. The status read is this call's own, so `signal` cancels it. */
  async latest({ signal }: { signal?: AbortSignal } = {}): Promise<RoundTime> {
    const { lastRound } = await this.algorand.client.algod.status().do(undefined, signal ? { signal } : undefined)
    return { round: lastRound, timestamp: await raceAbort(this.timestampOf(lastRound), signal) }
  }

  /**
   * The last round whose block timestamp is at or before `time`: the state "as of" that moment.
   *
   * Interpolates on block timestamps, falling back to bisection when a guess doesn't halve the range, so a lookup
   * takes a handful of header reads at ~50 ms each.
   *
   * @param time A `Date`, or seconds since the epoch
   * @param options.minRound The earliest round to return (default 1)
   * @param options.clamp Return `minRound` for a `time` before it, instead of throwing a `RangeError`
   * @param options.onProbe Called with each round read, e.g. to count requests
   */
  async roundAt(
    time: Date | number,
    { minRound = 1n, clamp = false, onProbe, signal }: RoundAtOptions = {},
  ): Promise<RoundTime> {
    const target = time instanceof Date ? Math.floor(time.getTime() / 1000) : Math.floor(time)
    const probe = async (round: bigint) => {
      signal?.throwIfAborted()
      onProbe?.(round)
      return raceAbort(this.timestampOf(round), signal)
    }

    const latest = await this.latest({ signal })
    if (target >= latest.timestamp) return latest
    let lo = BigInt(minRound)
    let loTs = await probe(lo)
    if (target < loTs) {
      if (clamp) return { round: lo, timestamp: loTs }
      throw new RangeError(`${new Date(target * 1000).toISOString()} is before round ${lo} (${new Date(loTs * 1000).toISOString()})`)
    }
    // invariant: ts(lo) <= target < ts(hi)
    let hi = latest.round
    let hiTs = latest.timestamp

    // Secant steps: estimate the target round from the two latest reads (block times barely change over short
    // spans, so each step cuts the error by orders of magnitude), until the estimate is within a few rounds. Then read
    // a small window around it at once to find the exact boundary. A step that stalls bisects instead.
    let prev = { round: lo, ts: loTs }
    let last = { round: hi, ts: hiTs }
    let probes = 0
    const update = (round: bigint, ts: number) => {
      if (ts <= target) {
        if (round > lo) [lo, loTs] = [round, ts]
      } else if (round < hi) {
        ;[hi, hiTs] = [round, ts]
      }
    }
    while (hi - lo > 1n) {
      if (probes >= MAX_PROBES) throw new Error(`roundAt: no round found for ${target} in ${MAX_PROBES} header reads`)
      let estimate =
        last.ts !== prev.ts ? last.round + ((last.round - prev.round) * BigInt(target - last.ts)) / BigInt(last.ts - prev.ts) : -1n
      if (estimate <= lo || estimate >= hi) estimate = lo + (hi - lo) / 2n
      const step = estimate > last.round ? estimate - last.round : last.round - estimate
      if (hi - lo <= WINDOW * 2n || step <= WINDOW) {
        // close: read every round around the estimate in one go
        const from = estimate - WINDOW > lo ? estimate - WINDOW : lo + 1n
        const to = estimate + WINDOW < hi ? estimate + WINDOW : hi - 1n
        const rounds: bigint[] = []
        for (let r = from; r <= to; r++) rounds.push(r)
        const read = await Promise.all(rounds.map(async (round) => ({ round, ts: await probe(round) })))
        probes += read.length
        for (const { round, ts } of read) update(round, ts)
        // the boundary was outside the window: carry on from the bracket's ends
        prev = { round: lo, ts: loTs }
        last = { round: hi, ts: hiTs }
        continue
      }
      const ts = await probe(estimate)
      probes++
      const span = hi - lo
      update(estimate, ts)
      prev = last
      last = { round: estimate, ts }
      if (hi - lo > span / 2n && step > span / 4n) {
        // a step that barely moved the bracket: bisect, and restart the secant from the bracket's ends
        const mid = lo + (hi - lo) / 2n
        update(mid, await probe(mid))
        probes++
        prev = { round: lo, ts: loTs }
        last = { round: hi, ts: hiTs }
      }
    }
    return { round: lo, timestamp: loTs }
  }
}
