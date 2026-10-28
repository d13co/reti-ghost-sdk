import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { requireDT } from "../errors.js"

/** A change of a pool's reported algod version (its `algodVer` global state key). */
export type AlgodVersionChange = {
  round: bigint
  /** The round's block timestamp, in seconds since the epoch */
  timestamp: number
  /** The version string after the round; "" when the key was removed or the pool deleted */
  algodVer: string
}

export type AlgodVersionChangesOptions = {
  /** Changes at this round or later (default: the pool's creation) */
  minRound?: number | bigint
  /** Changes at this round or earlier (default: the latest round) */
  maxRound?: number | bigint
  /** Aborts the listing; it rejects with the signal's reason */
  signal?: AbortSignal
}

/** The global state key a pool reports its node's algod version in. */
export const ALGOD_VERSION_KEY = "algodVer"

/** Changes asked for per request. */
const PAGE_LIMIT = 1_000

/**
 * Every change of a pool's reported algod version, oldest first, from the versions of the pool app filtered to its
 * `algodVer` key (`key=` on `/v2/applications/{id}/versions`): one request per ~1,000 changes, so a pool's whole
 * history is 1–2 requests. The node may return short or empty pages while it scans; the listing pages until the end.
 *
 * Needs the dtalgorand forks and a dtalgorand node with versions key filters; it doesn't probe for them. Errors pass
 * through: one for which `isDTUnsupported` is true without the forks or on a node without `/versions`, the node's own
 * error otherwise, a 504 (the node's time limit: narrow the range), or the signal's reason.
 */
export async function getPoolAlgodVersionChanges(
  algorand: AlgorandClient,
  poolAppId: number | bigint,
  { minRound, maxRound, signal }: AlgodVersionChangesOptions = {},
): Promise<AlgodVersionChange[]> {
  const dt = requireDT(algorand, "getPoolAlgodVersionChanges")
  const versions = dt.iterateAppVersions(BigInt(poolAppId), {
    key: ALGOD_VERSION_KEY,
    order: "asc",
    limit: PAGE_LIMIT,
    ...(minRound !== undefined ? { minRound: BigInt(minRound) } : {}),
    ...(maxRound !== undefined ? { maxRound: BigInt(maxRound) } : {}),
    ...(signal ? { signal } : {}),
  })
  const changes: AlgodVersionChange[] = []
  const text = new TextDecoder()
  for await (const { round, timestamp, keyValue } of versions) {
    const algodVer = keyValue === undefined ? "" : "valueRaw" in keyValue ? text.decode(keyValue.valueRaw) : String(keyValue.value)
    // a guard: the node lists the key's changes only, so a repeat of the previous value isn't a change
    if (changes.length > 0 && algodVer === changes[changes.length - 1].algodVer) continue
    changes.push({ round, timestamp, algodVer })
  }
  return changes
}
