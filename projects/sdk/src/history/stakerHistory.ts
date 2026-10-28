import type { StakedInfo, StakerPosition } from "../generated/RetiReaderSDK.js"
import { decodeStakerPoolSet } from "../decode.js"
import type { SeriesPoint } from "./series.js"

/**
 * A staker's deposits and withdrawals, rebuilt from on-chain state alone: no indexer, no account history.
 *
 * The registry's `sps` box for the staker is never deleted, so its versions give every pool the staker was ever in, and
 * when (memberships). Within a membership, with `p = balance − totalRewarded`: deposits always raise `entryRound`
 * (`addStake` sets it to the round + 320), epoch payouts add the same amount to `balance` and `totalRewarded`, and
 * withdrawals lower `balance`. So if (`p`, `entryRound`) is the same at two rounds, the staker made no deposit or
 * withdrawal between them. The search reads the staker's entry at a few of the rounds the pool's `stakers` box changed,
 * and narrows down the spans where it differs, in waves, until each change is pinned to one round.
 */

/** Rounds a deposit waits before it counts: `addStake` sets `entryRound` to its round plus this. */
export const STAKING_BLOCK_DELAY = 320n

/** The rounds the history search reads per wave by default: 4 query requests of 16 rounds on a dtalgorand node. */
export const HISTORY_ROUNDS_PER_WAVE = 64

/** A deposit or withdrawal, or both in one round (`mixed`). */
export type StakeEventKind = "deposit" | "withdrawal" | "mixed"

/** A deposit into or withdrawal from one pool. */
export type StakeEvent = {
  round: bigint
  /** The round's block timestamp, in seconds since the epoch */
  timestamp: number
  validatorId: bigint
  poolId: bigint
  poolAppId: bigint
  kind: StakeEventKind
  /** microAlgo moved: deposited or withdrawn; net (and usually 0) for `mixed` */
  amount: bigint
  /** The stake left in that pool after the round, in microAlgo */
  balanceAfter: bigint
  /** Reward tokens paid out with a withdrawal */
  rewardTokenPaid?: bigint
  /** The first deposit of a membership */
  joined?: true
  /** The withdrawal that left the pool */
  left?: true
  /**
   * The withdrawal may be understated: the pool paid an epoch reward in the round the staker left, and a reward paid
   * before the exit in that round isn't seen.
   */
  approximate?: true
}

/** A stretch of time a staker was in a pool. */
export type StakerPoolMembership = {
  validatorId: bigint
  poolId: bigint
  poolAppId: bigint
  joinRound: bigint
  /** Seconds since the epoch */
  joinTimestamp: number
  /** The round the staker left; undefined if still in the pool at the history's round */
  leaveRound?: bigint
  /** Seconds since the epoch */
  leaveTimestamp?: number
}

/** A staker's deposits and withdrawals as of `round`. */
export type StakerHistory = {
  /** Newest first */
  events: StakeEvent[]
  /** Every pool the staker was in, oldest join first */
  pools: StakerPoolMembership[]
  /** The round the history is as of */
  round: bigint
}

/** How far a `getStakerHistory` call has got, with what it has found so far. */
export type StakerHistoryProgress = {
  /** Memberships to search */
  pools: number
  /** Memberships whose change rounds are listed */
  poolsListed: number
  /** Memberships fully searched: their events in `partial` are final */
  poolsDone: number
  /** Waves of reads done */
  waves: number
  /** Rounds read */
  reads: number
  /** Every membership, and the events found so far: final for the pools done, some missing for the others */
  partial: StakerHistory
}

/** A version of a staker's `sps` box, as `/versions` lists it with values. */
export type StakerPoolSetVersion = { round: bigint; timestamp: number; deleted: boolean; value?: Uint8Array }

/** A round and its block timestamp (seconds). */
export type RoundTimestamp = { round: bigint; timestamp: number }

/**
 * Every pool a staker was in, and when, from the versions of their `sps` box (oldest first). Pools are compared by key,
 * not slot, since a re-join takes the first empty slot. Oldest join first.
 */
export function stakerMemberships(versions: StakerPoolSetVersion[]): StakerPoolMembership[] {
  const all: StakerPoolMembership[] = []
  const open = new Map<bigint, StakerPoolMembership>()
  for (const version of versions) {
    const keys = version.deleted || !version.value ? [] : decodeStakerPoolSet(version.value)
    const present = new Set(keys.map((k) => k.poolAppId))
    for (const [poolAppId, membership] of open) {
      if (present.has(poolAppId)) continue
      membership.leaveRound = version.round
      membership.leaveTimestamp = version.timestamp
      open.delete(poolAppId)
    }
    for (const key of keys) {
      if (open.has(key.poolAppId)) continue
      const membership: StakerPoolMembership = { ...key, joinRound: version.round, joinTimestamp: version.timestamp }
      open.set(key.poolAppId, membership)
      all.push(membership)
    }
  }
  return all
}

/** The search of one membership. */
export type PoolSearch = {
  poolAppId: bigint
  /**
   * The rounds the pool's `stakers` box changed during the membership, from the join (or, when the membership started
   * before the history's `minRound`, the round before it). The staker's entry is the same from one to the next.
   */
  rounds: RoundTimestamp[]
  /** The staker's entry at the indexes of `rounds` read so far */
  states: Map<number, StakedInfo>
  /** Indexes of `rounds` at which the staker deposited or withdrew: the entry differs from the one before. Ascending. */
  events: number[]
  /** Whether every event is found */
  done: boolean
}

/** Reads the staker's positions at each round. A point that fails (`ok: false`) is retried once. */
export type PositionsReader = (rounds: bigint[]) => Promise<SeriesPoint<StakerPosition[]>[]>

/** Reads each pool's last payout round at each round, pools in the order given. */
export type LastPayoutsReader = (rounds: bigint[], poolAppIds: bigint[]) => Promise<SeriesPoint<{ lastPayout: bigint }[]>[]>

/**
 * Whether each leave may be understated (`StakeEvent.approximate`): the pool paid a reward in the round the staker
 * left. One `read` of every leaving pool at every leave round (none without leaves), keyed by membership index. A
 * pool that didn't exist at a round reads as no payout. Throws the error of a round that can't be read.
 */
export async function approximateLeaves(pools: StakerPoolMembership[], read: LastPayoutsReader): Promise<Map<number, boolean>> {
  const approximate = new Map<number, boolean>()
  const leaving = pools.flatMap((m, k) => (m.leaveRound === undefined ? [] : [{ k, leave: m.leaveRound, poolAppId: m.poolAppId }]))
  if (leaving.length === 0) return approximate
  const rounds = [...new Set(leaving.map((l) => l.leave))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const poolAppIds = [...new Set(leaving.map((l) => l.poolAppId))]
  const points = await read(rounds, poolAppIds)
  const byRound = new Map(points.map((p) => [p.round, p]))
  for (const { k, leave, poolAppId } of leaving) {
    const point = byRound.get(leave)
    if (!point) throw new Error(`approximateLeaves: no read at round ${leave}`)
    if (!point.ok) throw point.error
    approximate.set(k, point.value[poolAppIds.indexOf(poolAppId)].lastPayout === leave)
  }
  return approximate
}

export type SearchOptions = {
  /** Most rounds read per wave, shared evenly by the open spans (each gets at least one); default 64 */
  roundsPerWave?: number
  signal?: AbortSignal
  /** Called after each wave, with every search as it stands */
  onWave?: (searches: PoolSearch[], progress: { waves: number; reads: number }) => void
}

/**
 * Finds the rounds at which the staker deposited into or withdrew from each pool, in waves of reads shared by all the
 * pools: the first reads both ends of every pool's rounds, and each after it splits the spans whose ends differ. A
 * round is never read twice, so a search reads at most every round listed. A round that fails twice throws; it's never
 * taken as the staker being absent.
 */
export async function searchEvents(
  pools: { poolAppId: bigint; rounds: RoundTimestamp[] }[],
  read: PositionsReader,
  { roundsPerWave = HISTORY_ROUNDS_PER_WAVE, signal, onWave }: SearchOptions = {},
): Promise<PoolSearch[]> {
  type Span = { search: PoolSearch; i: number; j: number }
  const positions = new Map<bigint, StakerPosition[]>()
  const timestamps = new Map<bigint, number>()
  const searches: PoolSearch[] = pools.map(({ poolAppId, rounds }) => ({
    poolAppId,
    rounds: rounds.map((r) => ({ ...r })),
    states: new Map(),
    events: [],
    done: rounds.length === 0,
  }))

  const stateAt = (search: PoolSearch, index: number): StakedInfo => {
    const known = search.states.get(index)
    if (known) return known
    const at = search.rounds[index]
    const position = positions.get(at.round)?.find((p) => p.poolAppId === search.poolAppId)
    if (!position) {
      throw new Error(`The staker isn't in pool ${search.poolAppId} at round ${at.round}, though their pool set lists it`)
    }
    if (at.timestamp === 0) at.timestamp = timestamps.get(at.round) ?? 0
    search.states.set(index, position.info)
    return position.info
  }

  const readRounds = async (rounds: bigint[]) => {
    let points = await read(rounds)
    signal?.throwIfAborted()
    const failed = points.filter((p) => !p.ok)
    if (failed.length > 0) {
      const retried = await read(failed.map((p) => p.round))
      signal?.throwIfAborted()
      const still = retried.find((p) => !p.ok)
      if (still && !still.ok) throw still.error
      points = [...points.filter((p) => p.ok), ...retried]
    }
    for (const p of points) {
      if (!p.ok) continue
      positions.set(p.round, p.value)
      timestamps.set(p.round, p.timestamp)
    }
  }

  let spans: Span[] = []
  const pending = new Set<bigint>()
  for (const search of searches) {
    const m = search.rounds.length
    if (m === 0) continue
    pending.add(search.rounds[0].round)
    pending.add(search.rounds[m - 1].round)
    if (m > 1) spans.push({ search, i: 0, j: m - 1 })
  }

  let waves = 0
  let reads = 0
  let first = true
  while (first || spans.length > 0) {
    if (pending.size > 0) {
      signal?.throwIfAborted()
      const rounds = [...pending].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      pending.clear()
      await readRounds(rounds)
      waves += 1
      reads += rounds.length
    }
    if (first) {
      // both ends of every pool's rounds: the join and the leave
      for (const search of searches) {
        if (search.rounds.length === 0) continue
        stateAt(search, 0)
        stateAt(search, search.rounds.length - 1)
      }
      first = false
    }

    const toSplit: Span[] = []
    const open: Span[] = []
    for (const span of spans) {
      const a = stateAt(span.search, span.i)
      const b = stateAt(span.search, span.j)
      if (sameStake(a, b)) continue
      if (span.j === span.i + 1) span.search.events.push(span.j)
      else toSplit.push(span)
    }
    const share = Math.max(1, Math.floor(roundsPerWave / Math.max(1, toSplit.length)))
    for (const span of toSplit) {
      const points = [span.i, ...splitPoints(span.search, span.i, span.j, share), span.j]
      for (let k = 1; k < points.length; k++) open.push({ search: span.search, i: points[k - 1], j: points[k] })
      for (const index of points) {
        const round = span.search.rounds[index].round
        if (!positions.has(round)) pending.add(round)
      }
    }
    spans = open

    const searching = new Set(spans.map((s) => s.search))
    for (const search of searches) {
      search.done = !searching.has(search)
      search.events.sort((a, b) => a - b)
    }
    onWave?.(searches, { waves, reads })
  }
  return searches
}

/** Whether the staker's stake is the same in two entries: no deposit or withdrawal between them. */
function sameStake(a: StakedInfo, b: StakedInfo): boolean {
  return a.entryRound === b.entryRound && a.balance - a.totalRewarded === b.balance - b.totalRewarded
}

/**
 * The indexes strictly inside (i, j) to read next: `share` of them spread evenly (all of them if fewer), plus, when
 * `entryRound` changed, the two around the last deposit, which `entryRound` names.
 */
function splitPoints(search: PoolSearch, i: number, j: number, share: number): number[] {
  const points = new Set<number>()
  const a = search.states.get(i)!
  const b = search.states.get(j)!
  if (a.entryRound !== b.entryRound) {
    const t = indexOfRound(search.rounds, b.entryRound - STAKING_BLOCK_DELAY, i + 1, j)
    if (t !== -1) {
      if (t - 1 > i) points.add(t - 1)
      if (t < j) points.add(t)
    }
  }
  const inner = j - i - 1
  if (inner <= share) {
    for (let k = i + 1; k < j; k++) points.add(k)
  } else {
    for (let k = 1; k <= share; k++) points.add(i + Math.floor(((j - i) * k) / (share + 1)))
  }
  return [...points].sort((x, y) => x - y)
}

/** The index of `round` in `rounds[from..to]` (ascending), or -1. */
function indexOfRound(rounds: RoundTimestamp[], round: bigint, from: number, to: number): number {
  let lo = from
  let hi = to
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = rounds[mid].round
    if (r === round) return mid
    if (r < round) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export type EventsFromStatesOptions = {
  /** The search starts before the membership did (the history's `minRound`): no join event */
  clipped?: boolean
  /** The pool paid a reward in the round the staker left: flag the leave `approximate` */
  approximateLeave?: boolean
}

/**
 * The events of one membership from its search, oldest first: the join, a deposit or withdrawal at each event round,
 * and the leave. Events whose states aren't read yet are left out, so it also works on a search in progress.
 *
 * At an event round, with s0 the entry before and s1 after: if `entryRound` changed and `totalRewarded` dropped, the
 * staker left and re-joined in one round (a withdrawal of s0's balance, then a deposit of s1's). Otherwise the change
 * in `p = balance − totalRewarded` is the amount: positive a deposit, negative a withdrawal, zero with `entryRound`
 * changed a deposit and withdrawal of the same amount (`mixed`).
 */
export function eventsFromStates(
  membership: StakerPoolMembership,
  search: Pick<PoolSearch, "rounds" | "states" | "events">,
  { clipped = false, approximateLeave = false }: EventsFromStatesOptions = {},
): StakeEvent[] {
  const { validatorId, poolId, poolAppId } = membership
  const base = { validatorId, poolId, poolAppId }
  const { rounds, states } = search
  const events: StakeEvent[] = []
  const tokens = (before: StakedInfo, after?: StakedInfo) =>
    before.rewardTokenBalance > 0n && (after === undefined || after.rewardTokenBalance === 0n)
      ? { rewardTokenPaid: before.rewardTokenBalance }
      : {}

  const joined = states.get(0)
  if (!clipped && joined && rounds.length > 0) {
    events.push({
      ...base,
      round: rounds[0].round,
      timestamp: membership.joinTimestamp,
      kind: "deposit",
      amount: joined.balance,
      balanceAfter: joined.balance,
      joined: true,
    })
  }

  for (const j of search.events) {
    const s0 = states.get(j - 1)
    const s1 = states.get(j)
    if (!s0 || !s1) continue
    const { round, timestamp } = rounds[j]
    const entryChanged = s1.entryRound !== s0.entryRound
    if (entryChanged && s1.totalRewarded < s0.totalRewarded) {
      events.push({ ...base, round, timestamp, kind: "withdrawal", amount: s0.balance, balanceAfter: 0n, ...tokens(s0), left: true })
      events.push({ ...base, round, timestamp, kind: "deposit", amount: s1.balance, balanceAfter: s1.balance, joined: true })
      continue
    }
    const delta = s1.balance - s1.totalRewarded - (s0.balance - s0.totalRewarded)
    const kind: StakeEventKind = delta > 0n ? "deposit" : delta < 0n ? "withdrawal" : "mixed"
    events.push({
      ...base,
      round,
      timestamp,
      kind,
      amount: delta < 0n ? -delta : delta,
      balanceAfter: s1.balance,
      ...(kind === "deposit" ? {} : tokens(s0, s1)),
    })
  }

  const last = states.get(rounds.length - 1)
  if (membership.leaveRound !== undefined && last) {
    events.push({
      ...base,
      round: membership.leaveRound,
      timestamp: membership.leaveTimestamp ?? 0,
      kind: "withdrawal",
      amount: last.balance,
      balanceAfter: 0n,
      ...tokens(last),
      left: true,
      ...(approximateLeave ? { approximate: true as const } : {}),
    })
  }
  return events
}

/** Every membership's events, newest first; events of one round keep their order within a pool, reversed. */
export function newestFirst(perPool: StakeEvent[][]): StakeEvent[] {
  const tagged = perPool.flatMap((events) => events.map((event, seq) => ({ event, seq })))
  tagged.sort((a, b) => {
    if (a.event.round !== b.event.round) return a.event.round > b.event.round ? -1 : 1
    if (a.event.poolAppId !== b.event.poolAppId) return a.event.poolAppId < b.event.poolAppId ? -1 : 1
    return b.seq - a.seq
  })
  return tagged.map((t) => t.event)
}
