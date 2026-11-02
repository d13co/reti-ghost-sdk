import { Bytes, Contract, contract, Global, log, op, Txn, uint64 } from "@algorandfoundation/algorand-typescript";
import { abimethod, Address } from "@algorandfoundation/algorand-typescript/arc4";
import { StakedInfo } from "../reti/types.algo";

/** One filled slot of a pool's `stakers` box. */
export type PoolStakerEntry = {
  poolAppId: uint64;
  slot: uint64;
  info: StakedInfo;
};

/** The bytes of one `StakedInfo` in a pool's `stakers` box: an address and four uint64s. */
const STAKED_INFO_BYTES: uint64 = 64;

/**
 * RetiQueryReader: the reads only a dtalgorand node's read-only queries (`POST /v2/query`) can make. Queries may read any
 * app's boxes (AVM 13's `app_box_*` opcodes, as if every app had set `ForeignBoxReads`), which simulate refuses, so this
 * reader never simulates: on a node without queries the SDK reads the same state another way.
 */
@contract({ avmVersion: 13 })
export class RetiQueryReader extends Contract {
  /**
   * Every filled slot of each pool's `stakers` box, pools in order and slots in box order. A pool that doesn't exist
   * (or didn't yet), or has no `stakers` box, logs nothing. Four full pools (200 stakers each, 80 bytes a slot) fill one
   * call's 64 KB of logs. `@ghostkit-chunk pools refsPerItem=1 maxPerTxn=4`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getPoolStakers(pools: uint64[]): PoolStakerEntry {
    const name = Bytes`stakers`;
    for (const pool of pools) {
      if (this.notCreatedYet(pool)) continue;
      const [, exists] = op.AppParams.appCreator(pool);
      if (!exists) continue;
      const [length, hasBox] = op.AppBox.length(pool, name);
      if (!hasBox) continue;
      for (let at: uint64 = 0; at + STAKED_INFO_BYTES <= length; at += STAKED_INFO_BYTES) {
        const info = op.AppBox.extract(pool, name, at, STAKED_INFO_BYTES);
        if (op.extract(info, 0, 32) === Global.zeroAddress.bytes) continue;
        // the ARC-4 encoding of PoolStakerEntry: every field is static, so it's the fields' bytes in order
        log(op.itob(pool).concat(op.itob(at / STAKED_INFO_BYTES)).concat(info));
      }
    }
    return {
      poolAppId: 0,
      slot: 0,
      info: { account: new Address(), balance: 0, totalRewarded: 0, rewardTokenBalance: 0, entryRound: 0 },
    };
  }

  /**
   * Whether an app id hadn't been created yet at the queried round: the ghost being created takes the next id, so
   * every id at or above its own didn't exist yet.
   */
  private notCreatedYet(id: uint64): boolean {
    return Txn.applicationId.id === 0 && id >= Global.currentApplicationId.id;
  }
}
