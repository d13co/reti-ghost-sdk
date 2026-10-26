import { encodeAddress } from "algosdk"

/** A big-endian unsigned integer of any width; 0 for empty bytes. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  return value
}

/** `prefix` followed by `id` as a big-endian uint64: the Reti registry's box names (`v` + validator id). */
export function uint64BoxName(prefix: string, id: number | bigint): Uint8Array {
  const name = new Uint8Array(prefix.length + 8)
  name.set(new TextEncoder().encode(prefix))
  new DataView(name.buffer).setBigUint64(prefix.length, BigInt(id))
  return name
}

/** A staker's entry in a pool's `stakers` box. */
export type PoolStaker = {
  /** The entry's slot in the box, 0-based */
  slot: number
  account: string
  balance: bigint
  totalRewarded: bigint
  rewardTokenBalance: bigint
  /** The round the stake counts from: entry plus 320 rounds for the consensus balance delay */
  entryRound: bigint
}

/** The size of a `StakedInfo` entry: address, then four uint64 */
const STAKED_INFO_BYTES = 64

/** Decodes a pool's `stakers` box (`StakedInfo[200]`), skipping empty slots. */
export function decodeStakersBox(box: Uint8Array): PoolStaker[] {
  const view = new DataView(box.buffer, box.byteOffset, box.byteLength)
  const stakers: PoolStaker[] = []
  for (let slot = 0; (slot + 1) * STAKED_INFO_BYTES <= box.length; slot++) {
    const at = slot * STAKED_INFO_BYTES
    const account = box.subarray(at, at + 32)
    if (account.every((b) => b === 0)) continue
    stakers.push({
      slot,
      account: encodeAddress(account),
      balance: view.getBigUint64(at + 32),
      totalRewarded: view.getBigUint64(at + 40),
      rewardTokenBalance: view.getBigUint64(at + 48),
      entryRound: view.getBigUint64(at + 56),
    })
  }
  return stakers
}

/** A pool in a staker's pool set: the registry's `ValidatorPoolKey`. */
export type StakerPoolKey = {
  validatorId: bigint
  poolId: bigint
  poolAppId: bigint
}

/** The size of a `ValidatorPoolKey`: three uint64 */
const POOL_KEY_BYTES = 24

/**
 * Decodes a staker's pool set (the registry's `sps` box, `ValidatorPoolKey[6]`), skipping empty slots. A re-join takes
 * the first empty slot, so a pool's slot can change: compare pools by key, not slot.
 */
export function decodeStakerPoolSet(value: Uint8Array): StakerPoolKey[] {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  const keys: StakerPoolKey[] = []
  for (let at = 0; at + POOL_KEY_BYTES <= value.length; at += POOL_KEY_BYTES) {
    const validatorId = view.getBigUint64(at)
    if (validatorId === 0n) continue
    keys.push({ validatorId, poolId: view.getBigUint64(at + 8), poolAppId: view.getBigUint64(at + 16) })
  }
  return keys
}
