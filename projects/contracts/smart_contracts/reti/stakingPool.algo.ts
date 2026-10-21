import { Contract, err } from "@algorandfoundation/algorand-typescript";
import { abimethod, Address } from "@algorandfoundation/algorand-typescript/arc4";
import { StakedInfo } from "./types.algo";

/*
 * Reti staking pool interface for strongly typed calls from our ghost reader
 */

export class StakingPool extends Contract {
  @abimethod({ readonly: true })
  getStakerInfo(staker: Address): StakedInfo {
    err("stub");
  }
}
