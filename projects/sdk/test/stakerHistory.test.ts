import { describe, expect, it } from "vitest"
import type { StakedInfo, StakerPosition } from "../src/generated/RetiReaderSDK.js"
import type { SeriesPoint } from "../src/history/series.js"
import {
  eventsFromStates,
  newestFirst,
  searchEvents,
  stakerMemberships,
  STAKING_BLOCK_DELAY,
  type PositionsReader,
  type StakeEvent,
  type StakerPoolMembership,
} from "../src/history/stakerHistory.js"
import { decodeStakerPoolSet } from "../src/decode.js"

const STAKER = "STAKER"
const POOL = 1001n
const VALIDATOR = 7n

/** What happens to the pool's `stakers` box in a round, in order. Rounds with no ops for the staker are other stakers. */
type Op =
  | { deposit: bigint }
  | { withdraw: bigint } // 0 = all
  | { payout: bigint }
  | { token: bigint }
  | { claim: true }
  | { other: true }

/** A pool ledger that follows the contract's rules for one staker. */
function simulate(script: [number, Op[]][]) {
  const history = new Map<bigint, StakedInfo | undefined>()
  const changes: bigint[] = []
  let entry: StakedInfo | undefined
  for (const [r, ops] of script) {
    const round = BigInt(r)
    for (const op of ops) {
      if ("deposit" in op) {
        entry = entry
          ? { ...entry, balance: entry.balance + op.deposit, entryRound: round + STAKING_BLOCK_DELAY }
          : { account: STAKER, balance: op.deposit, totalRewarded: 0n, rewardTokenBalance: 0n, entryRound: round + STAKING_BLOCK_DELAY }
      } else if ("withdraw" in op) {
        if (!entry) throw new Error(`withdraw without entry at ${r}`)
        const amount = op.withdraw === 0n ? entry.balance : op.withdraw
        entry = { ...entry, balance: entry.balance - amount, rewardTokenBalance: 0n }
        if (entry.balance === 0n) entry = undefined
      } else if ("payout" in op) {
        if (entry) entry = { ...entry, balance: entry.balance + op.payout, totalRewarded: entry.totalRewarded + op.payout }
      } else if ("token" in op) {
        if (entry) entry = { ...entry, rewardTokenBalance: entry.rewardTokenBalance + op.token }
      } else if ("claim" in op) {
        if (entry) entry = { ...entry, rewardTokenBalance: 0n }
      }
    }
    changes.push(round)
    history.set(round, entry && { ...entry })
  }

  /** The entry as of the end of `round`. */
  const at = (round: bigint): StakedInfo | undefined => {
    let state: StakedInfo | undefined
    for (const r of changes) {
      if (r > round) break
      state = history.get(r)
    }
    return state
  }

  /** Memberships, the way the registry's `sps` box would show them (end-of-round state). */
  const memberships: StakerPoolMembership[] = []
  let current: StakerPoolMembership | undefined
  for (const r of changes) {
    const present = history.get(r) !== undefined
    if (present && !current) {
      current = { validatorId: VALIDATOR, poolId: 1n, poolAppId: POOL, joinRound: r, joinTimestamp: Number(r) * 3 }
      memberships.push(current)
    } else if (!present && current) {
      current.leaveRound = r
      current.leaveTimestamp = Number(r) * 3
      current = undefined
    }
  }
  return { at, changes, memberships }
}

type Ledger = ReturnType<typeof simulate>

/** A reader over the ledger that counts the rounds it reads, and can fail some rounds a number of times. */
function reader(ledger: Ledger, fail = new Map<bigint, number>()) {
  const stats = { calls: 0, rounds: [] as bigint[] }
  const read: PositionsReader = async (rounds) => {
    stats.calls += 1
    stats.rounds.push(...rounds)
    return rounds.map((round): SeriesPoint<StakerPosition[]> => {
      const left = fail.get(round) ?? 0
      if (left > 0) {
        fail.set(round, left - 1)
        return { round, ok: false, error: new Error(`round ${round} failed`) }
      }
      const info = ledger.at(round)
      const value = info ? [{ staker: STAKER, validatorId: VALIDATOR, poolId: 1n, poolAppId: POOL, info }] : []
      return { round, ok: true, value, timestamp: Number(round) * 3 }
    })
  }
  return { read, stats }
}

/** The search over every membership, then their events, oldest first. */
async function history(ledger: Ledger, options: { roundsPerWave?: number; fail?: Map<bigint, number>; maxRound?: bigint } = {}) {
  const { read, stats } = reader(ledger, options.fail)
  const maxRound = options.maxRound ?? ledger.changes[ledger.changes.length - 1]
  const pools = ledger.memberships.map((m) => ({
    poolAppId: m.poolAppId,
    rounds: ledger.changes
      .filter((r) => r >= m.joinRound && r < (m.leaveRound ?? maxRound + 1n))
      .map((round) => ({ round, timestamp: Number(round) * 3 })),
  }))
  const waves: number[] = []
  const searches = await searchEvents(pools, read, {
    roundsPerWave: options.roundsPerWave,
    onWave: (_, progress) => waves.push(progress.waves),
  })
  const events = searches.flatMap((search, k) => eventsFromStates(ledger.memberships[k], search))
  return { events, stats, searches, waves }
}

/** The fields a test checks. */
const brief = (events: StakeEvent[]) =>
  events.map(({ round, kind, amount, balanceAfter, joined, left, rewardTokenPaid }) => ({
    round: Number(round),
    kind,
    amount,
    balanceAfter,
    ...(joined ? { joined } : {}),
    ...(left ? { left } : {}),
    ...(rewardTokenPaid !== undefined ? { rewardTokenPaid } : {}),
  }))

/** `count` rounds of other stakers' changes from `from`, one every `step` rounds. */
const noise = (from: number, count: number, step = 1): [number, Op[]][] =>
  Array.from({ length: count }, (_, i) => [from + i * step, [{ other: true }]])

describe("searchEvents + eventsFromStates", () => {
  it("finds a join and a later deposit", async () => {
    const ledger = simulate([[100, [{ deposit: 1000n }]], ...noise(101, 30), [131, [{ deposit: 500n }]], ...noise(132, 30)])
    const { events } = await history(ledger)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 131, kind: "deposit", amount: 500n, balanceAfter: 1500n },
    ])
  })

  it("finds a partial withdrawal between payouts", async () => {
    const ledger = simulate([
      [100, [{ deposit: 1000n }]],
      ...noise(101, 20),
      [121, [{ payout: 10n }]],
      [122, [{ withdraw: 300n }]],
      [123, [{ payout: 7n }]],
      ...noise(124, 20),
    ])
    const { events } = await history(ledger)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 122, kind: "withdrawal", amount: 300n, balanceAfter: 710n },
    ])
  })

  it("ends a membership with a full exit, withdrawing the balance with its rewards", async () => {
    const ledger = simulate([
      [100, [{ deposit: 1000n }]],
      [110, [{ payout: 25n }, { token: 4n }]],
      ...noise(111, 10),
      [121, [{ withdraw: 0n }]],
      ...noise(122, 5),
    ])
    const { events } = await history(ledger)
    expect(ledger.memberships[0].leaveRound).toBe(121n)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 121, kind: "withdrawal", amount: 1025n, balanceAfter: 0n, left: true, rewardTokenPaid: 4n },
    ])
  })

  it("splits a full exit and re-join in one round into a withdrawal and a deposit", async () => {
    const ledger = simulate([
      [100, [{ deposit: 1000n }]],
      [110, [{ payout: 50n }]],
      ...noise(111, 10),
      [125, [{ withdraw: 0n }, { deposit: 400n }]],
      ...noise(126, 10),
    ])
    const { events } = await history(ledger)
    expect(ledger.memberships).toHaveLength(1)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 125, kind: "withdrawal", amount: 1050n, balanceAfter: 0n, left: true },
      { round: 125, kind: "deposit", amount: 400n, balanceAfter: 400n, joined: true },
    ])
  })

  it("gives a re-join in a later round its own membership", async () => {
    const ledger = simulate([
      [100, [{ deposit: 1000n }]],
      ...noise(101, 5),
      [110, [{ withdraw: 0n }]],
      ...noise(111, 5),
      [120, [{ deposit: 2000n }]],
      ...noise(121, 5),
    ])
    const { events } = await history(ledger)
    expect(ledger.memberships.map((m) => [m.joinRound, m.leaveRound])).toEqual([
      [100n, 110n],
      [120n, undefined],
    ])
    expect(brief(newestFirst([events]))).toEqual([
      { round: 120, kind: "deposit", amount: 2000n, balanceAfter: 2000n, joined: true },
      { round: 110, kind: "withdrawal", amount: 1000n, balanceAfter: 0n, left: true },
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
    ])
  })

  it("isn't thrown by a payout in the same round as a deposit or withdrawal", async () => {
    const ledger = simulate([
      [100, [{ deposit: 1000n }]],
      ...noise(101, 10),
      [111, [{ payout: 20n }, { deposit: 100n }]],
      ...noise(112, 10),
      [122, [{ withdraw: 50n }, { payout: 30n }]],
      ...noise(123, 10),
    ])
    const { events } = await history(ledger)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 111, kind: "deposit", amount: 100n, balanceAfter: 1120n },
      { round: 122, kind: "withdrawal", amount: 50n, balanceAfter: 1100n },
    ])
  })

  it("reports a deposit and withdrawal of the same amount in one round as mixed", async () => {
    const ledger = simulate([[100, [{ deposit: 1000n }]], ...noise(101, 10), [111, [{ deposit: 200n }, { withdraw: 200n }]], ...noise(112, 10)])
    const { events } = await history(ledger)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 1000n, balanceAfter: 1000n, joined: true },
      { round: 111, kind: "mixed", amount: 0n, balanceAfter: 1000n },
    ])
  })

  it("follows p below zero once rewards are withdrawn", async () => {
    const ledger = simulate([
      [100, [{ deposit: 100n }]],
      [105, [{ payout: 50n }]],
      ...noise(106, 10),
      [116, [{ withdraw: 120n }]], // p = 30 - 50 = -20
      [117, [{ payout: 5n }]],
      ...noise(118, 10),
      [128, [{ withdraw: 10n }]], // p = -30
      ...noise(129, 10),
    ])
    const { events } = await history(ledger)
    expect(brief(events)).toEqual([
      { round: 100, kind: "deposit", amount: 100n, balanceAfter: 100n, joined: true },
      { round: 116, kind: "withdrawal", amount: 120n, balanceAfter: 30n },
      { round: 128, kind: "withdrawal", amount: 10n, balanceAfter: 25n },
    ])
  })

  it("retries a failed round once", async () => {
    const ledger = simulate([[100, [{ deposit: 1000n }]], ...noise(101, 10), [111, [{ withdraw: 1n }]], ...noise(112, 10)])
    const { events, stats } = await history(ledger, { fail: new Map([[121n, 1]]) })
    expect(brief(events)).toHaveLength(2)
    expect(stats.rounds.filter((r) => r === 121n)).toHaveLength(2)
  })

  it("throws when a round fails twice, rather than taking the staker as absent", async () => {
    const ledger = simulate([[100, [{ deposit: 1000n }]], ...noise(101, 10)])
    await expect(history(ledger, { fail: new Map([[110n, 2]]) })).rejects.toThrow("round 110 failed")
  })

  it("reads a small share of a busy pool's rounds, never one twice", async () => {
    const script: [number, Op[]][] = [[1000, [{ deposit: 5000n }]]]
    let round = 1001
    const deposits = new Set([1700, 2600])
    const withdrawals = new Set([1400, 3100, 3900])
    while (round < 4000) {
      if (deposits.has(round)) script.push([round, [{ deposit: 100n }]])
      else if (withdrawals.has(round)) script.push([round, [{ withdraw: 10n }]])
      else if (round % 10 === 0) script.push([round, [{ payout: 3n }]])
      else script.push([round, [{ other: true }]])
      round += 1
    }
    const ledger = simulate(script)
    const { events, stats, waves } = await history(ledger)
    expect(events.map((e) => [Number(e.round), e.kind])).toEqual([
      [1000, "deposit"],
      [1400, "withdrawal"],
      [1700, "deposit"],
      [2600, "deposit"],
      [3100, "withdrawal"],
      [3900, "withdrawal"],
    ])
    expect(new Set(stats.rounds).size).toBe(stats.rounds.length)
    expect(stats.rounds.length).toBeLessThan(400) // of 3,000
    expect(waves.at(-1)).toBeLessThanOrEqual(6)
  })

  it("starts mid-membership without a join event", async () => {
    const ledger = simulate([[100, [{ deposit: 1000n }]], ...noise(101, 20), [121, [{ withdraw: 100n }]], ...noise(122, 20)])
    const { read } = reader(ledger)
    const m = ledger.memberships[0]
    const rounds = [{ round: 114n, timestamp: 0 }, ...ledger.changes.filter((r) => r >= 115n).map((round) => ({ round, timestamp: Number(round) * 3 }))]
    const [search] = await searchEvents([{ poolAppId: POOL, rounds }], read)
    expect(search.rounds[0].timestamp).toBe(114 * 3)
    expect(brief(eventsFromStates(m, search, { clipped: true }))).toEqual([{ round: 121, kind: "withdrawal", amount: 100n, balanceAfter: 900n }])
  })

  it("flags an exit in a payout round as approximate", () => {
    const m: StakerPoolMembership = { validatorId: 1n, poolId: 1n, poolAppId: POOL, joinRound: 10n, joinTimestamp: 1, leaveRound: 20n, leaveTimestamp: 2 }
    const info: StakedInfo = { account: STAKER, balance: 5n, totalRewarded: 0n, rewardTokenBalance: 0n, entryRound: 330n }
    const [, leave] = eventsFromStates(m, { rounds: [{ round: 10n, timestamp: 1 }], states: new Map([[0, info]]), events: [] }, { approximateLeave: true })
    expect(leave).toMatchObject({ kind: "withdrawal", amount: 5n, left: true, approximate: true })
  })

  it("leaves out events whose states aren't read yet", () => {
    const m: StakerPoolMembership = { validatorId: 1n, poolId: 1n, poolAppId: POOL, joinRound: 10n, joinTimestamp: 1, leaveRound: 20n, leaveTimestamp: 2 }
    expect(eventsFromStates(m, { rounds: [{ round: 10n, timestamp: 1 }], states: new Map(), events: [] })).toEqual([])
  })
})

describe("stakerMemberships", () => {
  const key = (validatorId: number, poolId: number, poolAppId: number) => {
    const bytes = new Uint8Array(24)
    const view = new DataView(bytes.buffer)
    view.setBigUint64(0, BigInt(validatorId))
    view.setBigUint64(8, BigInt(poolId))
    view.setBigUint64(16, BigInt(poolAppId))
    return bytes
  }
  const set = (...keys: Uint8Array[]) => {
    const value = new Uint8Array(144)
    keys.forEach((k, slot) => value.set(k, slot * 24))
    return value
  }
  const empty = new Uint8Array(24)

  it("decodes a pool set, skipping empty slots", () => {
    expect(decodeStakerPoolSet(set(empty, key(3, 2, 99)))).toEqual([{ validatorId: 3n, poolId: 2n, poolAppId: 99n }])
  })

  it("builds memberships by key, not slot", () => {
    const versions = [
      { round: 10n, timestamp: 1, deleted: false, value: set(key(1, 1, 50)) },
      { round: 20n, timestamp: 2, deleted: false, value: set(key(1, 1, 50), key(2, 1, 60)) },
      { round: 30n, timestamp: 3, deleted: false, value: set(empty, key(2, 1, 60)) },
      // re-joins pool 50 in the first empty slot; pool 60 stays in slot 1
      { round: 40n, timestamp: 4, deleted: false, value: set(key(1, 1, 50), key(2, 1, 60)) },
      { round: 50n, timestamp: 5, deleted: false, value: set(key(1, 1, 50)) },
    ]
    expect(stakerMemberships(versions).map((m) => [m.poolAppId, m.joinRound, m.leaveRound])).toEqual([
      [50n, 10n, 30n],
      [60n, 20n, 50n],
      [50n, 40n, undefined],
    ])
  })
})
