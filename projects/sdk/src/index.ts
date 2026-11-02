import { microAlgo, type AlgorandClient } from "@algorandfoundation/algokit-utils"
import { ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"
import {
  RetiReaderSDK,
  type AccountBalance,
  type AssetHolding,
  type GhostkitNode,
  type GhostkitQueryLimits,
  type GhostkitSDKParams,
  type MbrAmountsAndProtocolConstraints,
  type NodePoolAssignmentConfig,
  type PoolState as RawPoolState,
  type PoolTotals,
  type StakerPosition,
  type Validator,
  type ValidatorConfig,
  type ValidatorCurState,
  type ValidatorPoolInfo,
  type ValidatorTotals,
} from "./generated/RetiReaderSDK.js"
import { bytesToBigInt, decodeStakersBox, type PoolStaker } from "./decode.js"
import { abortable, raceAbort, sim, simOptions } from "./abort.js"
import { FutureRoundError, isDTUnsupported, requireDT, RetiNotDeployedError, TimeTravelUnavailableError } from "./errors.js"
import { RoundClock, type RoundAtOptions, type RoundTime } from "./history/dateToRound.js"
import { getPoolAlgodVersionChanges, type AlgodVersionChange, type AlgodVersionChangesOptions } from "./history/algodVersions.js"
import { getChangeRounds, stakerPoolSetBoxName, type TimelineOptions, type TimelinePage, type TimelineTarget } from "./history/timeline.js"
import {
  approximateLeaves,
  eventsFromStates,
  HISTORY_ROUNDS_PER_WAVE,
  newestFirst,
  searchEvents,
  stakerMemberships,
  type PoolSearch,
  type PositionsReader,
  type RoundTimestamp,
  type StakerHistory,
  type StakerHistoryProgress,
  type StakerPoolMembership,
  type StakerPoolSetVersion,
} from "./history/stakerHistory.js"
import { pMap } from "./utils/p-map.js"
import { MAX_SERIES_POINTS, seriesRounds, type SeriesPoint, type SeriesRounds } from "./history/series.js"

export type {
  AccountBalance,
  AssetHolding,
  GhostkitNode,
  GhostkitQueryLimits,
  MbrAmountsAndProtocolConstraints,
  NodePoolAssignmentConfig,
  PoolTotals,
  StakerPosition,
  Validator,
  ValidatorConfig,
  ValidatorCurState,
  ValidatorPoolInfo,
  ValidatorTotals,
}
export type { StakedInfo } from "./generated/RetiReaderSDK.js"
export { GhostkitError } from "./generated/RetiReaderSDK.js"
export { FutureRoundError, RetiNotDeployedError, TimeTravelUnavailableError, isDTUnsupported } from "./errors.js"
export { RoundClock, type RoundAtOptions, type RoundTime } from "./history/dateToRound.js"
export { ALGOD_VERSION_KEY, type AlgodVersionChange, type AlgodVersionChangesOptions } from "./history/algodVersions.js"
export { MAX_UNBOUNDED_CHANGES, type Change, type TimelineOptions, type TimelinePage, type TimelineTarget } from "./history/timeline.js"
export { MAX_SERIES_POINTS, seriesRounds, type SeriesPoint, type SeriesRounds } from "./history/series.js"
export { decodeStakerPoolSet, type PoolStaker, type StakerPoolKey } from "./decode.js"
export {
  eventsFromStates,
  HISTORY_ROUNDS_PER_WAVE,
  searchEvents,
  STAKING_BLOCK_DELAY,
  stakerMemberships,
  type EventsFromStatesOptions,
  type PoolSearch,
  type PositionsReader,
  type RoundTimestamp,
  type SearchOptions,
  type StakeEvent,
  type StakeEventKind,
  type StakerHistory,
  type StakerHistoryProgress,
  type StakerPoolMembership,
  type StakerPoolSetVersion,
} from "./history/stakerHistory.js"

/** Per-call read options. */
export type ReadOptions = {
  /**
   * Read the state as of the end of this round instead of the latest. Overrides the SDK's own `round` (see `atRound`).
   *
   * On a node without time travel, a round within 20 of the latest reads the latest state, and an older round throws
   * `TimeTravelUnavailableError`. A round before the registry was created throws `RetiNotDeployedError`, and one the
   * node hasn't reached yet `FutureRoundError`.
   */
  round?: number | bigint
  /**
   * Aborts the read: its requests are cancelled and it rejects with the signal's reason (a `DOMException` named
   * `AbortError` by default). Cancelling needs the dtalgorand fork of algokit-utils; with stock algokit-utils
   * the read still rejects on abort, but its requests run to the end. Reads other calls share (node detection, the
   * registry's creation round, the node's status) carry on for them.
   */
  signal?: AbortSignal
}

/** Options for reads that only take a signal. */
export type SignalOptions = Pick<ReadOptions, "signal">

export type PoolBalanceAndLastPayout = {
  balance: bigint
  lastPayout: bigint
}

export type AssetInfo =
  | {
      index: bigint
      deleted: true
    }
  | {
      index: bigint
      params: {
        creator: string
        total: bigint
        decimals: number
        unitName: string
        name: string
      }
    }

/** A staking pool's global state and account balance. */
export type PoolState = Omit<RawPoolState, "stakeAccumulator" | "ewma"> & {
  /** uint128 accumulator of stake over the current bin */
  stakeAccumulator: bigint
  /** The pool's exponentially weighted moving average APY, as the UI's `fetchPoolApy` reads it (0 if unset) */
  ewma: bigint
}

/** The registry's global totals. */
export type RegistryTotals = {
  numValidators: number
  numStakers: bigint
  staked: bigint
}

/** Options for `getStakerHistory`. */
export type StakerHistoryOptions = {
  /** Only events at this round or later. Memberships that ended before it are left out. */
  minRound?: number | bigint
  /** The history as of this round; defaults to the latest */
  maxRound?: number | bigint
  /** Only this validator's pools */
  validatorId?: number | bigint
  /** Most rounds read per wave of the search (default 64: 4 query requests on a dtalgorand node) */
  roundsPerWave?: number
  /** Aborts the search: its requests are cancelled and it rejects with the signal's reason */
  signal?: AbortSignal
  /**
   * Called as the search goes: once the memberships are known, as their change rounds are listed, and after each wave of
   * reads, with the history found so far (`partial`), so an app can show it as it fills in.
   */
  onProgress?: (progress: StakerHistoryProgress) => void
}

/** An account and asset, for `getAssetHoldings`. */
export type AccountAssetRef = { account: string; assetId: number | bigint }

export type RetiGhostSDKParams = {
  /**
   * AlgoKit `AlgorandClient`. Past-round reads need the dtalgorand forks of algosdk and algokit-utils and a dtalgorand
   * node. Reads go through read-only queries (`POST /v2/query`) when the forks and the node have them, else simulate.
   */
  algorand: AlgorandClient
  /** Reti registry app id: 2714516089 on MainNet */
  registryAppId: number | bigint
  /** Default round for every read; omit to read the latest state. See `atRound`. */
  round?: number | bigint
  /**
   * A deployed reader app to call for reads at the latest round, instead of creating the ghost on the fly. Reads at a
   * past round always use the ghost, since a deployed reader may not have existed (or had other code) then.
   */
  ghostAppId?: bigint
  /**
   * Account the reads run as. On simulate it must hold `ghostFee` at the round read; defaults to the network's fee
   * sink, funded at every round. Queries check no fees, so any account works there (unset: the round's fee sink).
   */
  readerAccount?: string
  /**
   * How to read; see ghostkit. `auto` (default) uses read-only queries when the forks and the node support them, else a
   * dtalgorand node's extended simulate, else one simulate per group; `query` always queries (throws on stock algod and
   * on a node with queries off), `dt` always uses the extended simulate (throws on stock algod), `stock` one simulate per
   * group; or a ghostkit backend.
   */
  backend?: GhostkitSDKParams["backend"]
  /**
   * What each simulated group may spend on fees (it's never charged). Default 10 Algo, which covers 10,000 inner calls;
   * the fee sink holds far more at every round. Only on simulate; queries charge and check no fees.
   */
  ghostFee?: GhostkitSDKParams["ghostFee"]
  /** Milliseconds reads at the latest round reuse suggested params for (default 3,000) */
  cacheParamsTimeout?: number
  /** Log each query or simulate */
  debug?: boolean
}

/** The default `ghostFee`: 10 Algo per group (simulate only). */
const DEFAULT_GHOST_FEE = 10_000_000n

/**
 * How far from its latest round a node without time travel takes a round, reading the latest state for it. Such a node
 * can only read the latest state; this lets a round taken from `status()` be used for about a minute.
 */
const STOCK_ROUND_SLACK = 20n

/** How long a read of the node's latest round is reused for rounds that need it to be fresh. */
const STATUS_MAX_AGE_MS = 1_000

/** The furthest back a program can read block headers: `block` takes rounds up to 1,000 before the current one. */
const BLOCK_LOOKBACK = 1000n

/**
 * For calls with no inner transactions: pay just the minimum fee, so they also work at early rounds, when the fee sink
 * held too little for the default `ghostFee` (simulate only).
 */
const MIN_FEE = { extraFee: microAlgo(0) }

/** `getValidators` is chunked into groups of this many validators (its `@ghostkit-chunk` maxPerGroup). */
const VALIDATORS_PER_GROUP = 64
/** The fewest validators `getAllValidators` reads in its first request: MainNet's count fits, so a cold read is one. */
const ALL_VALIDATORS_MIN_GUESS = 256
/** How many validators past the most seen `getAllValidators` reads, for those added since. */
const ALL_VALIDATORS_HEADROOM = 16

const roundUpTo = (n: number, step: number) => Math.ceil(n / step) * step

/**
 * Read-only SDK for the Reti staking registry. Every read takes `{ round }` to read the state as of that round, or
 * pin a round for all reads with `atRound`.
 */
export class RetiGhostSDK {
  static baseSDK = RetiReaderSDK

  public readonly algorand: AlgorandClient
  public readonly registryAppId: bigint
  /** Default round for every read; undefined reads the latest state. */
  public readonly round?: bigint
  /** The ghost reader, simulated on the fly at any round. */
  public readonly ghost: RetiReaderSDK
  /** The reader for latest-state reads: the deployed reader if `ghostAppId` is set, else the ghost. */
  public readonly baseSDK: RetiReaderSDK
  /** Round ↔ timestamp lookups, from block headers. */
  public readonly clock: RoundClock

  /** State shared with the SDKs `atRound` returns. */
  private shared: {
    creationRound?: Promise<bigint | undefined>
    /** The node's latest round when last read; rounds only grow, so any round up to it exists. */
    latest?: { round: bigint; at: number }
    statusRead?: Promise<bigint>
    /** The most validators any read has seen: `getAllValidators` reads this many (and some) in its first request. */
    validatorCount?: number
  }

  constructor({
    algorand,
    registryAppId,
    round,
    ghostAppId,
    readerAccount,
    backend,
    ghostFee = DEFAULT_GHOST_FEE,
    cacheParamsTimeout,
    debug,
  }: RetiGhostSDKParams) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.round = round === undefined ? undefined : BigInt(round)
    const params: GhostkitSDKParams = { algorand, readerAccount, backend, ghostFee, cacheParamsTimeout, debug }
    this.ghost = new RetiReaderSDK(params)
    this.baseSDK = ghostAppId ? new RetiReaderSDK({ ...params, ghostAppId }) : this.ghost
    this.clock = new RoundClock(algorand)
    this.shared = {}
  }

  /** The same SDK with every read as of the end of `round`; `undefined` reads the latest state. */
  atRound(round: number | bigint | undefined): RetiGhostSDK {
    return Object.assign(Object.create(this) as RetiGhostSDK, { round: round === undefined ? undefined : BigInt(round) })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Node

  /** What kind of node this is, its simulate limits, and `query` (the query limits) when reads go through queries. */
  getNode(): Promise<GhostkitNode> {
    return this.ghost.getNode()
  }

  /**
   * Fetches what the first reads wait for: the node's limits (and suggested params on a node without queries), the
   * registry's creation round, and the node's latest round, which every read at a past round checks (on a time-travel
   * node, rounds up to the latest seen need no further status read). Calls fetch them anyway; this lets them arrive
   * while the app does other work. Errors reject here; the read that needs it retries.
   *
   * @param options.signal Stops the wait only: the fetches are shared and carry on for the reads that need them
   */
  async prefetch({ signal }: SignalOptions = {}): Promise<void> {
    signal?.throwIfAborted()
    await raceAbort(
      Promise.all([this.ghost.prefetch(), this.getRegistryCreationRound(), this.latestRound(0n, STATUS_MAX_AGE_MS)]),
      signal,
    )
  }

  /** Whether reads at any round since genesis work: a dtalgorand node with time travel, and the dtalgorand forks. */
  async supportsTimeTravel(): Promise<boolean> {
    const node = await this.getNode()
    return node.kind === "dt" && node.limits.timeTravel
  }

  /**
   * The most rounds the node simulates in one request, which bounds what one `getTimestampsAtRounds` request covers
   * (more are split across requests). 0 if it simulates one round per request: stock algod, or a dtalgorand node with
   * multi-round simulate off. On a node with queries, requests cover `getNode().query.maxRounds` rounds each (16 on the local MainNet node) and run in parallel;
   * one call takes any number of rounds either way.
   */
  async getMaxRounds(): Promise<number> {
    return (await this.getNode()).limits.maxRounds
  }

  /**
   * The round the registry was created at, the earliest round its state can be read at. Undefined if the node can't
   * tell (not a dtalgorand node). Cached.
   */
  getRegistryCreationRound(): Promise<bigint | undefined> {
    if (!this.shared.creationRound) {
      // `algorand.dt` only exists on the dtalgorand fork of algokit-utils
      const dt = (this.algorand as Partial<Pick<AlgorandClient, "dt">>).dt
      if (!dt) return Promise.resolve(undefined)
      const lookup = dt
        .getAppVersions(this.registryAppId, { order: "asc", limit: 1 })
        .then(({ versions }) => versions[0]?.round)
        .catch((e) => {
          if (isDTUnsupported(e)) return undefined
          throw e
        })
      lookup.catch(() => {
        if (this.shared.creationRound === lookup) this.shared.creationRound = undefined
      })
      this.shared.creationRound = lookup
    }
    return this.shared.creationRound
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Registry

  /** The number of validators in the registry. */
  async getNumValidators(options: ReadOptions = {}): Promise<number> {
    return (await this.getRegistryTotals(options)).numValidators
  }

  /** The registry's validator count, total stakers and total stake, from its global state. */
  async getRegistryTotals(options: ReadOptions = {}): Promise<RegistryTotals> {
    const round = await this.roundFor(options)
    const { signal } = options
    const state = await this.algorand.app.getGlobalState(this.registryAppId, {
      ...(round !== undefined ? { round } : {}),
      ...(signal ? { signal } : {}),
    })
    const uint = (key: string) => {
      const value = state[key]?.value
      if (value === undefined) throw new Error(`${key} not found in the registry's global state${round !== undefined ? ` at round ${round}` : ""}`)
      return BigInt(value)
    }
    return { numValidators: Number(uint("numV")), numStakers: uint("numStakers"), staked: uint("staked") }
  }

  /** The registry's MBR amounts and protocol constraints. */
  async getMbrAmountsAndProtocolConstraints(options: ReadOptions = {}): Promise<MbrAmountsAndProtocolConstraints> {
    const [data] = await this.read(options, (r) =>
      r.getMbrAmountsAndProtocolConstraints({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId },
        ...sim(options),
      }),
    )
    return data
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Validators

  /** Each validator's config, in input order. */
  async getValidatorConfig(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<ValidatorConfig[]> {
    return this.read(options, (r) =>
      r.getValidatorConfig({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: validatorIds.map(BigInt) },
        ...sim(options),
      }),
    )
  }

  /** Each validator's current state, in input order. */
  async getValidatorStates(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<ValidatorCurState[]> {
    return this.read(options, (r) =>
      r.getValidatorStates({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: validatorIds.map(BigInt) },
        ...sim(options),
      }),
    )
  }

  /** Each validator's pools, in input order. */
  async getPools(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<ValidatorPoolInfo["poolInfo"][][]> {
    const ids = validatorIds.map(BigInt)
    const results = await this.read(options, (r) =>
      r.getPools({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: ids },
        ...sim(options),
      }),
    )
    const byValidator = new Map<bigint, ValidatorPoolInfo["poolInfo"][]>()
    for (const { validatorId, poolInfo } of results) {
      let pools = byValidator.get(validatorId)
      if (!pools) byValidator.set(validatorId, (pools = []))
      pools.push(poolInfo)
    }
    return ids.map((id) => byValidator.get(id) ?? [])
  }

  /** Each validator's node to pool assignments, in input order. */
  async getNodePoolAssignments(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<NodePoolAssignmentConfig[]> {
    return this.read(options, (r) =>
      r.getNodePoolAssignments({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: validatorIds.map(BigInt) },
        ...sim(options),
      }),
    )
  }

  /** Each validator's config, state, pools and node assignments, in input order. */
  async getValidators(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<Validator[]> {
    return this.read(options, (r) =>
      r.getValidators({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: validatorIds.map(BigInt) },
        ...sim(options),
      }),
    )
  }

  /**
   * Every validator at the read's round, in id order (ids run from 1 to the registry's count): usually one request.
   *
   * The count and validators 1..N go in one batch, where N is a guess: the most validators this SDK has seen (or
   * `expectedCount`) plus headroom, and at least {@link ALL_VALIDATORS_MIN_GUESS}. Ids past the count read as empty,
   * for a global state read each, and are dropped. Only if the registry has outgrown the guess does a second request
   * read the rest, at the same round.
   */
  async getAllValidators(options: ReadOptions & { expectedCount?: number } = {}): Promise<Validator[]> {
    const { signal } = options
    const known = Math.max(this.shared.validatorCount ?? 0, options.expectedCount ?? 0)
    const guess = roundUpTo(Math.max(known + ALL_VALIDATORS_HEADROOM, ALL_VALIDATORS_MIN_GUESS), VALIDATORS_PER_GROUP)
    const idRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i))
    return this.read(options, async (r) => {
      const [[totals], validators] = await r.batch(
        (s) => [
          s.getRegistryTotals({ methodArgsOrArgsArray: { registryAppId: this.registryAppId }, extraMethodCallArgs: MIN_FEE }),
          s.getValidators({ methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: idRange(1, guess) } }),
        ],
        simOptions({ signal }),
      )
      const count = Number(totals.numValidators)
      this.shared.validatorCount = Math.max(this.shared.validatorCount ?? 0, count)
      if (count <= guess) return validators.slice(0, count)
      const rest = await r.getValidators({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: idRange(guess + 1, count) },
        ...sim(options),
      })
      return [...validators, ...rest]
    })
  }

  /** Each validator's pool count, stakers and stake, in input order: a small read, made for charts. */
  async getValidatorTotals(validatorIds: (number | bigint)[], options: ReadOptions = {}): Promise<ValidatorTotals[]> {
    return this.read(options, (r) =>
      r.getValidatorTotals({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: validatorIds.map(BigInt) },
        ...sim(options),
      }),
    )
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pools

  /** Each pool's global state and account balance, in input order. */
  async getPoolStates(poolAppIds: (number | bigint)[], options: ReadOptions = {}): Promise<PoolState[]> {
    const states = await this.read(options, (r) =>
      r.getPoolStates({ methodArgsOrArgsArray: { pools: poolAppIds.map(BigInt) }, ...sim(options) }),
    )
    return states.map((s) => ({ ...s, stakeAccumulator: bytesToBigInt(s.stakeAccumulator), ewma: bytesToBigInt(s.ewma) }))
  }

  /** Each pool's stakers and stake, in input order: a small read, made for charts. */
  async getPoolTotals(poolAppIds: (number | bigint)[], options: ReadOptions = {}): Promise<PoolTotals[]> {
    return this.read(options, (r) => r.getPoolTotals({ methodArgsOrArgsArray: { pools: poolAppIds.map(BigInt) }, ...sim(options) }))
  }

  /** Each pool's balance and last payout round, in input order. */
  async getPoolBalancesAndLastPayouts(poolAppIds: (number | bigint)[], options: ReadOptions = {}): Promise<PoolBalanceAndLastPayout[]> {
    const data = await this.read(options, (r) =>
      r.getPoolBalancesAndLastPayouts({
        methodArgsOrArgsArray: { poolAppIds: poolAppIds.map(BigInt) },
        ...sim(options),
      }),
    )
    return data.map(([balance, lastPayout]) => ({ balance, lastPayout }))
  }

  /** Each pool's reported algod version, or "" if it has none, in input order. */
  async getPoolAlgodVersions(poolAppIds: (number | bigint)[], options: ReadOptions = {}): Promise<string[]> {
    return this.read(options, (r) => r.getAlgodVersion({ methodArgsOrArgsArray: { poolAppIds: poolAppIds.map(BigInt) }, ...sim(options) }))
  }

  /**
   * The stakers of a pool, from its `stakers` box (one REST read). Empty slots are left out; each entry keeps its slot.
   * An empty list if the pool or its box doesn't exist at the round.
   */
  async getPoolStakers(poolAppId: number | bigint, options: ReadOptions = {}): Promise<PoolStaker[]> {
    const round = await this.roundFor(options)
    const { signal } = options
    try {
      const box = await this.algorand.app.getBoxValue(BigInt(poolAppId), "stakers", {
        ...(round !== undefined ? { round } : {}),
        ...(signal ? { signal } : {}),
      })
      return decodeStakersBox(box)
    } catch (e) {
      signal?.throwIfAborted()
      if ((e as { status?: number })?.status === 404 || /not found|does not exist/i.test(String((e as Error)?.message))) return []
      throw e
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Stakers and accounts

  /** Every position of each staker: one entry per pool the staker is in, stakers in input order. */
  async getStakerPositions(stakers: string[], options: ReadOptions = {}): Promise<StakerPosition[]> {
    return this.read(options, (r) =>
      r.getStakerPositions({
        methodArgsOrArgsArray: { registryAppId: this.registryAppId, stakers },
        ...sim(options),
      }),
    )
  }

  /** Each account's balance and minimum balance, in input order; zero for accounts that don't exist. */
  async getAccountBalances(accounts: string[], options: ReadOptions = {}): Promise<AccountBalance[]> {
    return this.read(options, (r) => r.getAccountBalances({ methodArgsOrArgsArray: { accounts }, ...sim(options) }))
  }

  /** Each account's holding of an asset, in input order. */
  async getAssetHoldings(holdings: AccountAssetRef[], options: ReadOptions = {}): Promise<AssetHolding[]> {
    return this.read(options, (r) =>
      r.getAssetHoldings({
        methodArgsOrArgsArray: { holdings: holdings.map(({ account, assetId }): [string, bigint] => [account, BigInt(assetId)]) },
        ...sim(options),
      }),
    )
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Assets and blocks

  /** Each asset's basic params, or `deleted: true` if it doesn't exist, in input order. */
  async getAssets(assetIds: (number | bigint)[], options: ReadOptions = {}): Promise<AssetInfo[]> {
    const data = await this.read(options, (r) =>
      r.getAssets({ methodArgsOrArgsArray: { assetIds: assetIds.map(BigInt) }, ...sim(options) }),
    )
    return data.map((asset): AssetInfo =>
      asset.creator === ALGORAND_ZERO_ADDRESS_STRING
        ? { index: asset.assetId, deleted: true }
        : {
            index: asset.assetId,
            params: {
              creator: asset.creator,
              total: asset.total,
              decimals: asset.decimals,
              unitName: asset.unitName,
              name: asset.name,
            },
          },
    )
  }

  /**
   * The timestamps of the `num` blocks before the round (the latest if none): rounds round - num to round - 1, oldest
   * first. `num` can be at most 1,000, the furthest back a program can read block headers.
   */
  async getBlockTimestamps(num: number, options: ReadOptions = {}): Promise<bigint[]> {
    // the method reads the rounds before its validity window, so it always needs a round: the latest, read fresh
    const round = (await this.roundFor(options)) ?? (await raceAbort(this.latestRound(0n, 0), options.signal))
    return abortable(options.signal, () =>
      this.ghost.atRound(round).getBlockTimestamps({ methodArgsOrArgsArray: { num: BigInt(num) }, ...sim(options) }),
    )
  }

  /**
   * Each round's block timestamp, from one request (query or simulate) per `max-rounds` rounds on a dtalgorand node
   * (rounds any distance apart). Rounds are deduplicated and sorted; a round that can't be read is `ok: false`. The
   * timestamps are cached in `clock`.
   */
  async getTimestampsAtRounds(rounds: (number | bigint)[], options: SignalOptions = {}): Promise<SeriesPoint<number>[]> {
    const list = seriesRounds(rounds, Infinity)
    if (list.length === 0) return []
    const results = await abortable(options.signal, () =>
      this.ghost.atRounds(
        list,
        (s) => s.getRoundTimestamp({ methodArgsOrArgsArray: {}, extraMethodCallArgs: MIN_FEE }),
        simOptions(options),
      ),
    )
    // the reader rejects with the reason itself since ghostkit 0.1.0-dt.3; a guard in case an abort still shows as failed rounds
    options.signal?.throwIfAborted()
    return results.map((r): SeriesPoint<number> => {
      if (!r.ok) return { round: r.round, ok: false, error: r.error }
      const timestamp = Number(r.value[0])
      this.clock.remember(r.round, timestamp)
      return { round: r.round, ok: true, value: timestamp, timestamp }
    })
  }

  /**
   * The first round from `start` whose block timestamp is at or after `target`, scanning up to 1,000 rounds in one
   * request, query or simulate (at `start + 1000`, or the latest round if that's sooner). Undefined if no round in that
   * span reaches `target`, or `start` is past the latest round. The result is cached in `clock`.
   *
   * On a dtalgorand node that reads several rounds per request, the node's status is read only when `start + 1000`
   * (or `knownRound`) turns out not to exist yet.
   *
   * @param target A `Date`, or seconds since the epoch
   * @param options.knownRound A round the caller knows the node has, such as the latest it has seen: the scan stops
   * there, which avoids the status read and the failed attempt near the tip
   * @param options.signal Aborts the scan (see `ReadOptions.signal`)
   */
  async firstRoundAtOrAfter(
    start: number | bigint,
    target: Date | number,
    { knownRound, signal }: { knownRound?: number | bigint } & SignalOptions = {},
  ): Promise<RoundTime | undefined> {
    const from = BigInt(start)
    if (from < 0n) throw new RangeError(`firstRoundAtOrAfter: start must not be negative`)
    const seconds = target instanceof Date ? Math.ceil(target.getTime() / 1000) : Math.ceil(target)
    const args = { start: from, target: BigInt(Math.max(0, seconds)) }
    const end = from + BLOCK_LOOKBACK
    const known = knownRound !== undefined ? BigInt(knownRound) : undefined

    const node = await raceAbort(this.getNode(), signal)
    const scanAt = (at: bigint) =>
      abortable(signal, async () => {
        if (node.limits.maxRounds > 0) {
          // a request for several rounds fails a missing round in its own result; a single-round request gets an HTTP
          // 500, which algokit-utils retries for ~14 s
          const [result] = await this.ghost.atRounds(
            [at],
            (s) => s.firstRoundAtOrAfter({ methodArgsOrArgsArray: args, extraMethodCallArgs: MIN_FEE }),
            simOptions({ signal }),
          )
          if (!result.ok) throw result.error
          return result.value[0]
        }
        const [found] = await this.ghost
          .atRound(at)
          .firstRoundAtOrAfter({ methodArgsOrArgsArray: args, extraMethodCallArgs: MIN_FEE, ...sim({ signal }) })
        return found
      })
    const latest = () => raceAbort(this.latestRound(0n, 0), signal)

    let found: [bigint, bigint]
    if (node.limits.maxRounds > 0 || (known !== undefined && known >= from)) {
      const first = known !== undefined && known >= from && known < end ? known : end
      try {
        found = await scanAt(first)
      } catch (e) {
        // an abort is never the round not existing yet
        signal?.throwIfAborted()
        // most likely the round doesn't exist yet: retry at the latest round if so
        const last = await latest()
        if (first <= last) throw e
        if (from > last) return undefined
        found = await scanAt(last)
      }
    } else {
      const last = await latest()
      if (from > last) return undefined
      found = await scanAt(end < last ? end : last)
    }

    const [round, timestamp] = found
    if (round === 0n) return undefined
    this.clock.remember(round, Number(timestamp))
    return { round, timestamp: Number(timestamp) }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // History

  /**
   * The last round whose block timestamp is at or before `time` (a `Date`, or seconds since the epoch). Searches from
   * the registry's creation round by default, and returns that round for an earlier `time` (`clamp: false` throws a
   * `RangeError` instead).
   */
  async roundAt(time: Date | number, { minRound, clamp = true, onProbe, signal }: RoundAtOptions = {}): Promise<RoundTime> {
    const min = minRound ?? (await raceAbort(this.getRegistryCreationRound(), signal)) ?? 1n
    return this.clock.roundAt(time, { minRound: min, clamp, onProbe, signal })
  }

  /**
   * The block timestamp of a round, in seconds since the epoch. Header reads are cached and shared, so `signal` stops
   * the wait, not the read.
   */
  timestampOf(round: number | bigint, { signal }: SignalOptions = {}): Promise<number> {
    return raceAbort(this.clock.timestampOf(round), signal)
  }

  /**
   * The rounds at which a validator, pool, staker or the registry changed, newest first by default. Rounds only: read
   * the state at a chosen round with `{ round }`. Bounded by `minRound`, or limited to the last 1,000 changes. Throws an
   * error for which `isDTUnsupported` is true without the dtalgorand forks or on a node without `/versions`.
   */
  getChangeRounds(target: TimelineTarget, options?: TimelineOptions): Promise<TimelinePage> {
    return getChangeRounds(this.algorand, this.registryAppId, target, options)
  }

  /**
   * Every change of a pool's reported algod version (`algodVer`), oldest first, with each round's timestamp: the pool
   * app's versions filtered to that key, one request per ~1,000 changes (a pool's whole history is 1–2). Needs a
   * dtalgorand node with versions key filters; errors pass through (`isDTUnsupported` without the forks or `/versions`).
   */
  getPoolAlgodVersionChanges(poolAppId: number | bigint, options?: AlgodVersionChangesOptions): Promise<AlgodVersionChange[]> {
    return getPoolAlgodVersionChanges(this.algorand, poolAppId, options)
  }

  /**
   * Every pool a staker was ever in, and when, oldest join first: the versions of the registry's `sps` box for the
   * staker, which is never deleted (one request per 1,000 changes to it). Throws an error for which `isDTUnsupported` is
   * true without the dtalgorand forks or on a node without `/versions`.
   */
  async getStakerPools(staker: string, { maxRound, signal }: { maxRound?: number | bigint } & SignalOptions = {}): Promise<StakerPoolMembership[]> {
    const { versions } = await this.stakerPoolSetVersions(staker, maxRound, signal)
    return stakerMemberships(versions)
  }

  /**
   * Every position of each staker at each round: one request (query or simulate) per `max-rounds` rounds on a
   * dtalgorand node. Each point carries its round's block timestamp, also cached in `clock`.
   */
  async getStakerPositionsSeries(
    stakers: string[],
    rounds: SeriesRounds,
    { maxPoints = MAX_SERIES_POINTS, signal }: { maxPoints?: number } & SignalOptions = {},
  ): Promise<SeriesPoint<StakerPosition[]>[]> {
    const list = seriesRounds(rounds, maxPoints)
    return this.seriesAt(
      list,
      (s) => s.getStakerPositions({ methodArgsOrArgsArray: { registryAppId: this.registryAppId, stakers } }),
      signal,
    )
  }

  /**
   * A staker's deposits and withdrawals across every pool they were ever in, newest first, rebuilt from on-chain state
   * (no indexer). It lists when the staker joined and left each pool, then when each pool's `stakers` box changed during
   * the membership, and reads the staker's entry at a few of those rounds, narrowing down in waves to the rounds their
   * stake changed. The cost depends on how often the pools changed, not on how active the staker was: a daily-payout
   * pool over two years with 10 events is ~150–285 rounds read in 3–4 waves.
   *
   * Limits: each needs two actions by this staker in one block, and isn't handled.
   * - Several deposits in one round are one event.
   * - A join and a full exit in one round don't show; a deposit then a full exit shows only the withdrawal of the
   *   balance before.
   * - A payout and a full exit in one round understate the withdrawal by that round's reward; such a withdrawal is
   *   flagged `approximate`.
   * - A deposit and a withdrawal in one round show as one event of the net amount (`mixed` when they cancel out).
   * - A removal by the validator's owner or manager looks like a withdrawal. Reward token claims outside a withdrawal
   *   don't show.
   *
   * Throws `TimeTravelUnavailableError` on a node without time travel.
   */
  async getStakerHistory(
    staker: string,
    { minRound, maxRound, validatorId, roundsPerWave = HISTORY_ROUNDS_PER_WAVE, signal, onProgress }: StakerHistoryOptions = {},
  ): Promise<StakerHistory> {
    await this.requireTimeTravel(signal)
    const { versions, round } = await this.stakerPoolSetVersions(staker, maxRound, signal)
    const min = minRound === undefined ? undefined : BigInt(minRound)
    const validator = validatorId === undefined ? undefined : BigInt(validatorId)
    const pools = stakerMemberships(versions).filter(
      (m) => (validator === undefined || m.validatorId === validator) && (min === undefined || m.leaveRound === undefined || m.leaveRound >= min),
    )
    const clipped = pools.map((m) => min !== undefined && m.joinRound < min)
    const approximate = new Map<number, boolean>()
    let searches: PoolSearch[] = []
    const progress = { pools: pools.length, poolsListed: 0, poolsDone: 0, waves: 0, reads: 0 }

    const history = (): StakerHistory => ({
      events: newestFirst(
        searches.map((search, k) => eventsFromStates(pools[k], search, { clipped: clipped[k], approximateLeave: approximate.get(k) })),
      ),
      pools,
      round,
    })
    const report = () => onProgress?.({ ...progress, partial: history() })
    report()

    // whether each leave may be understated: the pool paid a reward in that round. Every leave is read in one batch,
    // alongside the search.
    const leaves = approximateLeaves(pools, async (leaveRounds, poolAppIds) => {
      const points = await this.seriesAt(
        leaveRounds,
        (s) => s.getPoolBalancesAndLastPayouts({ methodArgsOrArgsArray: { poolAppIds } }),
        signal,
      )
      return points.map((p) => (p.ok ? { ...p, value: p.value.map(([, lastPayout]) => ({ lastPayout })) } : p))
    }).then((flags) => flags.forEach((flag, k) => approximate.set(k, flag)))
    // it's awaited below; until then a failure mustn't go unhandled
    leaves.catch(() => {})

    const rounds = await pMap(
      pools,
      async (m, k) => {
        const list = await this.membershipRounds(m, clipped[k] ? min : undefined, round, signal)
        progress.poolsListed += 1
        report()
        return list
      },
      { concurrency: 8 },
    )

    const read: PositionsReader = async (list) => {
      const chunks: bigint[][] = []
      for (let at = 0; at < list.length; at += MAX_SERIES_POINTS) chunks.push(list.slice(at, at + MAX_SERIES_POINTS))
      const points = await Promise.all(chunks.map((chunk) => this.getStakerPositionsSeries([staker], chunk, { signal })))
      return points.flat()
    }
    searches = await searchEvents(
      pools.map((m, k) => ({ poolAppId: m.poolAppId, rounds: rounds[k] })),
      read,
      {
        roundsPerWave,
        signal,
        onWave: (current, wave) => {
          searches = current
          progress.waves = wave.waves
          progress.reads = wave.reads
          progress.poolsDone = current.filter((s) => s.done).length
          report()
        },
      },
    )
    await raceAbort(leaves, signal)
    return history()
  }

  /**
   * Each validator's totals at each round: one request (query or simulate) per `max-rounds` rounds on a dtalgorand
   * node. Each point carries its round's block timestamp, also cached in `clock`. See `seriesAt` for rounds that fail.
   */
  async getValidatorTotalsSeries(
    validatorIds: (number | bigint)[],
    rounds: SeriesRounds,
    { maxPoints = MAX_SERIES_POINTS, signal }: { maxPoints?: number } & SignalOptions = {},
  ): Promise<SeriesPoint<ValidatorTotals[]>[]> {
    const list = seriesRounds(rounds, maxPoints)
    const ids = validatorIds.map(BigInt)
    return this.seriesAt(
      list,
      (s) => s.getValidatorTotals({ methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds: ids } }),
      signal,
    )
  }

  /**
   * Each pool's totals at each round: one request (query or simulate) per `max-rounds` rounds on a dtalgorand node.
   * Each point carries its round's block timestamp, also cached in `clock`.
   */
  async getPoolTotalsSeries(
    poolAppIds: (number | bigint)[],
    rounds: SeriesRounds,
    { maxPoints = MAX_SERIES_POINTS, signal }: { maxPoints?: number } & SignalOptions = {},
  ): Promise<SeriesPoint<PoolTotals[]>[]> {
    const list = seriesRounds(rounds, maxPoints)
    const pools = poolAppIds.map(BigInt)
    return this.seriesAt(list, (s) => s.getPoolTotals({ methodArgsOrArgsArray: { pools } }), signal)
  }

  /**
   * The registry's totals at each round: one request (query or simulate) per `max-rounds` rounds on a dtalgorand
   * node. Each point carries its round's block timestamp, also cached in `clock`.
   */
  async getRegistryTotalsSeries(
    rounds: SeriesRounds,
    { maxPoints = MAX_SERIES_POINTS, signal }: { maxPoints?: number } & SignalOptions = {},
  ): Promise<SeriesPoint<RegistryTotals>[]> {
    const list = seriesRounds(rounds, maxPoints)
    const points = await this.seriesAt(
      list,
      (s) => s.getRegistryTotals({ methodArgsOrArgsArray: { registryAppId: this.registryAppId }, extraMethodCallArgs: MIN_FEE }),
      signal,
    )
    return points.map((p): SeriesPoint<RegistryTotals> => {
      if (!p.ok) return p
      const [totals] = p.value
      return {
        ...p,
        value: { numValidators: Number(totals.numValidators), numStakers: totals.numStakers, staked: totals.staked },
      }
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  /**
   * Runs a ghost read at each round with the round's block timestamp in the same request, caching the timestamps. A
   * round that can't be read is an `ok: false` point with its error (see `ReadOptions.round`); the others still read.
   * On a node without time travel, rounds near the latest all get one read of the latest state, with the timestamp of
   * the newest round the read can see (the latest, or a round or two before it).
   *
   * An abort rejects the whole series with the signal's reason; it never becomes failed points.
   */
  private async seriesAt<T>(rounds: bigint[], read: (s: RetiReaderSDK) => Promise<T>, signal?: AbortSignal): Promise<SeriesPoint<T>[]> {
    type Outcome = { ok: true; value: unknown } | { ok: false; error: Error }
    const plans = await this.planRounds(rounds, signal)
    const past = plans.flatMap((p) => ("at" in p && p.at !== undefined ? [p.at] : []))
    const needsLatest = plans.some((p) => "at" in p && p.at === undefined)
    const withTimestamp = (s: RetiReaderSDK) => [read(s), s.getRoundTimestamp({ methodArgsOrArgsArray: {}, extraMethodCallArgs: MIN_FEE })] as const
    const [pastResults, latest] = await Promise.all([
      past.length > 0 ? this.ghost.atRounds(past, withTimestamp, simOptions({ signal })) : [],
      needsLatest
        ? this.ghost.batch(withTimestamp, simOptions({ signal })).then(
            (value): Outcome => ({ ok: true, value }),
            (error): Outcome => {
              signal?.throwIfAborted()
              return { ok: false, error }
            },
          )
        : undefined,
    ])
    // the reader rejects with the reason itself since ghostkit 0.1.0-dt.3; a guard in case an abort still shows as failed rounds
    signal?.throwIfAborted()
    const byRound = new Map<bigint, Outcome>(pastResults.map((r) => [r.round, r]))
    return plans.map((p): SeriesPoint<T> => {
      if ("error" in p) return { round: p.round, ok: false, error: p.error }
      const r = p.at === undefined ? latest! : byRound.get(p.at)!
      if (!r.ok) return { round: p.round, ok: false, error: r.error }
      const [value, [ts]] = r.value as [T, bigint[]]
      const timestamp = Number(ts)
      // a read of the latest state isn't at p.round, so its timestamp isn't p.round's
      if (p.at !== undefined) this.clock.remember(p.at, timestamp)
      return { round: p.round, ok: true, value, timestamp }
    })
  }

  /** Throws `TimeTravelUnavailableError` unless the node and the loaded libraries can read past rounds. */
  private async requireTimeTravel(signal?: AbortSignal): Promise<void> {
    const node = await raceAbort(this.getNode(), signal)
    if (node.kind === "dt" && node.limits.timeTravel) return
    const [last, creation] = await raceAbort(Promise.all([this.latestRound(0n, STATUS_MAX_AGE_MS), this.getRegistryCreationRound()]), signal)
    throw new TimeTravelUnavailableError(creation ?? 1n, last, node.kind === "stock" ? node.reason : "time travel is off")
  }

  /**
   * Every version of a staker's `sps` box up to `maxRound` (the latest when undefined), with values, oldest first, and
   * the round the listing is as of. The round is fixed before the first page, so every page lists the same range.
   */
  private async stakerPoolSetVersions(
    staker: string,
    maxRound: number | bigint | undefined,
    signal?: AbortSignal,
  ): Promise<{ versions: StakerPoolSetVersion[]; round: bigint }> {
    const dt = requireDT(this.algorand, "getStakerPools")
    const round = maxRound !== undefined ? BigInt(maxRound) : await raceAbort(this.latestRound(0n, STATUS_MAX_AGE_MS), signal)
    const name = stakerPoolSetBoxName(staker)
    const versions: StakerPoolSetVersion[] = []
    let next: string | undefined
    do {
      const page = await dt.getBoxVersions(this.registryAppId, name, {
        includeValues: true,
        order: "asc",
        limit: 1_000,
        maxRound: round,
        ...(next ? { next } : {}),
        ...(signal ? { signal } : {}),
      })
      for (const { round, timestamp, deleted, value } of page.versions) versions.push({ round, timestamp, deleted, ...(value ? { value } : {}) })
      next = page.nextToken
    } while (next)
    return { versions, round }
  }

  /**
   * The rounds a pool's `stakers` box changed during a membership, up to `round`: from the join or, when the history
   * starts later (`from`), from the round before `from`, whose timestamp is filled in when it's read.
   */
  private async membershipRounds(
    m: StakerPoolMembership,
    from: bigint | undefined,
    round: bigint,
    signal?: AbortSignal,
  ): Promise<RoundTimestamp[]> {
    const first = from ?? m.joinRound
    const last = (m.leaveRound ?? round + 1n) - 1n
    const rounds: RoundTimestamp[] = from !== undefined ? [{ round: from - 1n, timestamp: 0 }] : []
    let next: string | undefined
    while (first <= last) {
      const page = await this.getChangeRounds(
        { poolStakers: m.poolAppId },
        { minRound: first, maxRound: last, order: "asc", limit: 10_000, ...(next ? { next } : {}), ...(signal ? { signal } : {}) },
      )
      for (const { round, timestamp } of page.changes) rounds.push({ round, timestamp })
      next = page.next
      if (!next) break
    }
    // the join changes the box; keep the search's first round the join even if the listing disagrees
    if (from === undefined && rounds[0]?.round !== m.joinRound) rounds.unshift({ round: m.joinRound, timestamp: m.joinTimestamp })
    return rounds
  }

  /** The round a read is at (the call's, else the SDK's; undefined for the latest state). Throws if it can't be read. */
  private async roundFor(options: ReadOptions): Promise<bigint | undefined> {
    options.signal?.throwIfAborted()
    const round = options.round ?? this.round
    if (round === undefined) return undefined
    const [plan] = await this.planRounds([BigInt(round)], options.signal)
    if ("error" in plan) throw plan.error
    return plan.at
  }

  /**
   * Where each read goes: `at` its round, `at: undefined` for the latest state (rounds near the latest on a node
   * without time travel), or why it can't be read: `RetiNotDeployedError` before the registry existed (when the node
   * can tell), `TimeTravelUnavailableError` for older rounds on a node without time travel, `FutureRoundError` past the
   * node's latest round.
   */
  private async planRounds(rounds: bigint[], signal?: AbortSignal): Promise<RoundPlan[]> {
    const highest = rounds.reduce((max, r) => (r > max ? r : max), -1n)
    // any round up to one the node has reported exists; only read its status for a higher round
    const known = this.shared.latest?.round ?? -1n
    // shared reads: an abort stops the wait, not the reads
    const [node, creation, reported] = await raceAbort(
      Promise.all([this.getNode(), this.getRegistryCreationRound(), highest > known ? this.latestRound(highest, Infinity) : undefined]),
      signal,
    )
    const timeTravel = node.kind === "dt" && node.limits.timeTravel
    // without time travel, rounds are measured from the latest, so it has to be fresh
    const last = timeTravel ? (reported ?? known) : await raceAbort(this.latestRound(0n, STATUS_MAX_AGE_MS), signal)
    const reason = node.kind === "stock" ? node.reason : "time travel is off"
    return rounds.map((round): RoundPlan => {
      if (creation !== undefined && round < creation) return { round, error: new RetiNotDeployedError(round, creation) }
      if (timeTravel) return round > last ? { round, error: new FutureRoundError(round, last) } : { round, at: round }
      if (round > last + STOCK_ROUND_SLACK) return { round, error: new FutureRoundError(round, last) }
      if (round < last - STOCK_ROUND_SLACK) return { round, error: new TimeTravelUnavailableError(round, last, reason) }
      return { round, at: undefined }
    })
  }

  /**
   * The node's latest round, reusing the last read if it's at least `atLeast` and no older than `maxAge` ms. Concurrent
   * callers share one status read.
   */
  private latestRound(atLeast: bigint, maxAge: number): Promise<bigint> {
    const cached = this.shared.latest
    if (cached && cached.round >= atLeast && Date.now() - cached.at <= maxAge) return Promise.resolve(cached.round)
    if (!this.shared.statusRead) {
      const read = this.algorand.client.algod
        .status()
        .do()
        .then(({ lastRound }) => {
          if (!this.shared.latest || lastRound >= this.shared.latest.round) this.shared.latest = { round: lastRound, at: Date.now() }
          return lastRound
        })
      const clear = () => {
        if (this.shared.statusRead === read) this.shared.statusRead = undefined
      }
      read.then(clear, clear)
      this.shared.statusRead = read
    }
    return this.shared.statusRead
  }

  /** The reader for a read: the latest-state reader, or the ghost pinned at the read's round. */
  private async reader(options: ReadOptions): Promise<RetiReaderSDK> {
    const round = await this.roundFor(options)
    return round === undefined ? this.baseSDK : this.ghost.atRound(round)
  }

  /** A generated reader method's call at the read's round, rejecting with the signal's reason once it aborts. */
  private read<T>(options: ReadOptions, call: (reader: RetiReaderSDK) => Promise<T>): Promise<T> {
    return abortable(options.signal, async () => call(await this.reader(options)))
  }
}

/** Where a read at `round` goes: `at` that round, `at: undefined` for the latest state, or why it can't be read. */
type RoundPlan = { round: bigint; at: bigint | undefined } | { round: bigint; error: Error }
