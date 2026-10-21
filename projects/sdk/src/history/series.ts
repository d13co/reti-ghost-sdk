/** The rounds of a series: a list, or `points` rounds spread evenly from `from` to `to`, both included. */
export type SeriesRounds = (number | bigint)[] | { from: number | bigint; to: number | bigint; points: number }

/** One point of a series: the value at a round and the round's block timestamp (seconds), or why it couldn't be read there. */
export type SeriesPoint<T> = { round: bigint } & ({ ok: true; value: T; timestamp: number } | { ok: false; error: Error })

/** Most points per series by default: what a dtalgorand node with default limits takes in one simulate. */
export const MAX_SERIES_POINTS = 256

/** The rounds of a series, deduplicated and in ascending order. */
export function seriesRounds(rounds: SeriesRounds, maxPoints = MAX_SERIES_POINTS): bigint[] {
  let list: bigint[]
  if (Array.isArray(rounds)) {
    list = rounds.map(BigInt)
  } else {
    const from = BigInt(rounds.from)
    const to = BigInt(rounds.to)
    const points = Math.floor(rounds.points)
    if (to < from) throw new RangeError(`series: to (${to}) is before from (${from})`)
    if (points < 1) throw new RangeError(`series: points must be at least 1`)
    if (points === 1) {
      list = [to]
    } else {
      const steps = BigInt(points - 1)
      list = Array.from({ length: points }, (_, i) => from + ((to - from) * BigInt(i)) / steps)
    }
  }
  list = [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (list.length > maxPoints) {
    throw new RangeError(`series: ${list.length} rounds is more than ${maxPoints}; pass maxPoints to allow more`)
  }
  return list
}
