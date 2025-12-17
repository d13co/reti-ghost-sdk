import { Contract, err, uint64 } from "@algorandfoundation/algorand-typescript";
import { abimethod, Address, StaticArray, Uint16, Uint32, Uint64, Uint8 } from "@algorandfoundation/algorand-typescript/arc4";
import { ValidatorConfig, ValidatorCurState, PoolInfo, NodePoolAssignmentConfig } from "./types.algo";

/*
 * Reti interface for strongly typed calls from our ghost reader
 */

export class Reti extends Contract {
  @abimethod({ readonly: true })
  getValidatorConfig(validatorId: uint64): ValidatorConfig {
    err("stub");
  }

  @abimethod({ readonly: true })
  getValidatorState(validatorId: uint64): ValidatorCurState {
    err("stub");
  }

  @abimethod({ readonly: true })
  getPools(validatorId: uint64): PoolInfo[] {
    err("stub");
  }

  @abimethod({ readonly: true })
  getNodePoolAssignments(validatorId: uint64): NodePoolAssignmentConfig {
    err("stub");
  }
}
