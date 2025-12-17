import { clone, Contract, Global, log, uint64 } from "@algorandfoundation/algorand-typescript";
import { NodeConfig, PoolInfo, ValidatorConfig, ValidatorCurState } from "../reti/types.algo";
import {
  abimethod,
  Address,
  compileArc4,
  encodeArc4,
  StaticArray,
  Uint16,
  Uint32,
  Uint64,
  Uint8,
} from "@algorandfoundation/algorand-typescript/arc4";
import { NodePoolAssignmentConfig } from "../reti/types.algo";
import { Reti } from "../reti/contract.algo";

export type ValidatorPoolInfo = {
  validatorId: uint64;
  // poolId: Uint8;
  poolInfo: PoolInfo;
};

export class RetiReader extends Contract {
  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorConfig(registryAppId: uint64, validatorIds: uint64[]): ValidatorConfig {
    for (const validatorId of validatorIds) {
      const { returnValue } = compileArc4(Reti).call.getValidatorConfig({
        appId: registryAppId,
        args: [validatorId],
      });
      log(encodeArc4(returnValue));
    }
    return {
      id: 0,
      owner: new Address(),
      manager: new Address(),
      nfdForInfo: 0,
      entryGatingType: new Uint8(0),
      entryGatingAddress: new Address(),
      entryGatingAssets: new StaticArray(new Uint64(0), new Uint64(0), new Uint64(0), new Uint64(0)),
      gatingAssetMinBalance: 0,
      rewardTokenId: 0,
      rewardPerPayout: 0,
      epochRoundLength: new Uint32(0),
      percentToValidator: new Uint32(0),
      validatorCommissionAddress: new Address(),
      minEntryStake: 0,
      maxAlgoPerPool: 0,
      poolsPerNode: new Uint8(0),
      sunsettingOn: 0,
      sunsettingTo: 0,
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorStates(registryAppId: uint64, validatorIds: uint64[]): ValidatorCurState {
    for (const validatorId of validatorIds) {
      const { returnValue } = compileArc4(Reti).call.getValidatorState({
        appId: registryAppId,
        args: [validatorId],
      });
      log(encodeArc4(returnValue));
    }
    return {
      numPools: new Uint16(0),
      totalStakers: 0,
      totalAlgoStaked: 0,
      rewardTokenHeldBack: 0,
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getPools(registryAppId: uint64, validatorIds: uint64[]): ValidatorPoolInfo {
    // we can't type an array return type, so we log each one individually
    for (const validatorId of validatorIds) {
      const { returnValue: poolInfoArr } = compileArc4(Reti).call.getPools({
        appId: registryAppId,
        args: [validatorId],
      });
      for (const poolInfo of clone(poolInfoArr)) {
        log(encodeArc4({ validatorId, poolInfo }));
      }
    }

    return {
      validatorId: 0,
      poolInfo: {
        poolAppId: 0,
        totalStakers: new Uint16(0),
        totalAlgoStaked: 0,
      },
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getNodePoolAssignments(registryAppId: uint64, validatorIds: uint64[]): NodePoolAssignmentConfig {
    for (const validatorId of validatorIds) {
      const { returnValue } = compileArc4(Reti).call.getNodePoolAssignments({
        appId: registryAppId,
        args: [validatorId],
      });
      log(encodeArc4(returnValue));
    }
    const n = new NodeConfig({ poolAppIds: new StaticArray(new Uint64(0), new Uint64(0), new Uint64(0)) })
    return { nodes: new StaticArray(clone(n), clone(n), clone(n), clone(n), clone(n), clone(n), clone(n), clone(n)) };
  }
}
