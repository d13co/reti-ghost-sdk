import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { decodeAddress } from "algosdk"
import { uint64BoxName } from "../decode.js"
import { requireDT } from "../errors.js"

/** What to list the changes of. */
export type TimelineTarget =
  /** A validator's record in the registry (`v` box): config, state, pools, node assignments. */
  | { validator: number | bigint }
  /** The registry's global state: validator count, total stakers and stake. */
  | { registry: true }
  /** A pool app's global state: payouts, stake, stakers, APY. */
  | { pool: number | bigint }
  /** A pool's `stakers` box: stakes entering, leaving or being paid. */
  | { poolStakers: number | bigint }
  /** The set of pools a staker is in (the registry's `sps` box for the staker). */
  | { staker: string }

/** A round at which the target changed. */
export type Change = {
  round: bigint
  /** The round's block timestamp, in seconds since the epoch */
  timestamp: number
  /** Whether the target was deleted in this round */
  deleted: boolean
}

export type TimelineOptions = {
  /** Changes at this round or later. Required unless `order` is `desc` with `limit` at most 1,000. */
  minRound?: number | bigint
  /** Changes at this round or earlier; defaults to the latest round */
  maxRound?: number | bigint
  /** Most changes to return (default 1,000, at most 10,000) */
  limit?: number
  /** `desc` (default): newest first; `asc`: oldest first */
  order?: "asc" | "desc"
  /** `next` of the previous page */
  next?: string
  /** Aborts the request */
  signal?: AbortSignal
}

export type TimelinePage = {
  changes: Change[]
  /** Pass as `next` for the following page; undefined on the last page */
  next?: string
}

/** The most changes a timeline call may return without a `minRound`. */
export const MAX_UNBOUNDED_CHANGES = 1_000

/**
 * The rounds at which a validator, pool, staker or the registry changed, from a dtalgorand node's `/versions`
 * endpoints. It lists rounds only, never values: read the state at a chosen round with the SDK's `{ round }` reads.
 *
 * The full history is large (the registry: ~80k changes since Jan 2025, one validator: ~10k), so a call is either
 * bounded by `minRound` or limited to the last 1,000 changes.
 *
 * Throws an error for which `isDTUnsupported` is true without the dtalgorand forks or on a node without `/versions`.
 */
export async function getChangeRounds(
  algorand: AlgorandClient,
  registryAppId: bigint,
  target: TimelineTarget,
  { minRound, maxRound, limit = MAX_UNBOUNDED_CHANGES, order = "desc", next, signal }: TimelineOptions = {},
): Promise<TimelinePage> {
  if (minRound === undefined && !(order === "desc" && limit <= MAX_UNBOUNDED_CHANGES)) {
    throw new Error(`getChangeRounds: set minRound, or use order 'desc' with a limit of at most ${MAX_UNBOUNDED_CHANGES}`)
  }
  const options = {
    ...(minRound !== undefined ? { minRound: BigInt(minRound) } : {}),
    ...(maxRound !== undefined ? { maxRound: BigInt(maxRound) } : {}),
    limit,
    order,
    ...(next ? { next } : {}),
    ...(signal ? { signal } : {}),
  }
  const dt = requireDT(algorand, "getChangeRounds")
  const page =
    "validator" in target
      ? await dt.getBoxVersions(registryAppId, uint64BoxName("v", target.validator), options)
      : "registry" in target
        ? await dt.getAppVersions(registryAppId, options)
        : "pool" in target
          ? await dt.getAppVersions(BigInt(target.pool), options)
          : "poolStakers" in target
            ? await dt.getBoxVersions(BigInt(target.poolStakers), "stakers", options)
            : await dt.getBoxVersions(registryAppId, stakerPoolSetBoxName(target.staker), options)
  return {
    changes: page.versions.map(({ round, timestamp, deleted }) => ({ round, timestamp, deleted })),
    ...(page.nextToken ? { next: page.nextToken } : {}),
  }
}

/** The registry's box of the pools a staker is in: `sps` + the staker's public key. */
export function stakerPoolSetBoxName(staker: string): Uint8Array {
  const key = decodeAddress(staker).publicKey
  const name = new Uint8Array(3 + key.length)
  name.set(new TextEncoder().encode("sps"))
  name.set(key, 3)
  return name
}
