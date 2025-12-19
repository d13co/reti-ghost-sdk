import { assert, Asset, Bytes, clone, Contract, FixedArray, Global, log, op, Txn, uint64 } from "@algorandfoundation/algorand-typescript";
import { AssetInfo, Constraints, MbrAmounts, NodeConfig, PoolInfo, ValidatorConfig, ValidatorCurState } from "../reti/types.algo";
import {
  abimethod,
  Address,
  baremethod,
  compileArc4,
  encodeArc4,
  Uint16,
  Uint32,
  Uint64,
  Uint8,
} from "@algorandfoundation/algorand-typescript/arc4";
import { NodePoolAssignmentConfig } from "../reti/types.algo";
import { Reti } from "../reti/contract.algo";

export type ValidatorPoolInfo = {
  validatorId: uint64;
  poolInfo: PoolInfo;
};

export type Validator = {
  config: ValidatorConfig;
  state: ValidatorCurState;
  poolInfo: PoolInfo[];
  nodeAssignment: NodePoolAssignmentConfig;
};

export type MbrAmountsAndProtocolConstraints = {
  mbrAmounts: MbrAmounts;
  constraints: Constraints;
}

export class RetiReader extends Contract {
  @baremethod({ allowActions: ["UpdateApplication", "DeleteApplication"] })
  adminOnly(): void {
    assert(Txn.sender === Global.creatorAddress);
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getMbrAmountsAndProtocolConstraints(registryAppId: uint64): MbrAmountsAndProtocolConstraints {
    const reti = compileArc4(Reti)
    const mbrAmounts = reti.call.getMbrAmounts({
      appId: registryAppId,
    }).returnValue;

    const constraints = reti.call.getProtocolConstraints({
      appId: registryAppId,
    }).returnValue;

    log(encodeArc4({ mbrAmounts, constraints }));

    return {
      mbrAmounts,
      constraints,
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorConfig(registryAppId: uint64, validatorIds: uint64[]): ValidatorConfig {
    for (const validatorId of validatorIds) {
      log(encodeArc4(this.getRemoteValidatorConfig(registryAppId, validatorId)));
    }
    return this.getEmptyConfig();
  }

  private getRemoteValidatorConfig(registryAppId: uint64, validatorId: uint64): ValidatorConfig {
    return compileArc4(Reti).call.getValidatorConfig({
      appId: registryAppId,
      args: [validatorId],
    }).returnValue;
  }

  private getEmptyConfig(): ValidatorConfig {
    return {
      id: 0,
      owner: new Address(),
      manager: new Address(),
      nfdForInfo: 0,
      entryGatingType: new Uint8(0),
      entryGatingAddress: new Address(),
      entryGatingAssets: new FixedArray(new Uint64(0), new Uint64(0), new Uint64(0), new Uint64(0)),
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
      log(encodeArc4(this.getRemoteValidatorState(registryAppId, validatorId)));
    }
    return this.getEmptyState();
  }

  private getRemoteValidatorState(registryAppId: uint64, validatorId: uint64): ValidatorCurState {
    return compileArc4(Reti).call.getValidatorState({
      appId: registryAppId,
      args: [validatorId],
    }).returnValue;
  }

  private getEmptyState(): ValidatorCurState {
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
      const poolInfoArr = this.getRemotePoolInfo(registryAppId, validatorId);
      for (const poolInfo of clone(poolInfoArr)) {
        log(encodeArc4({ validatorId, poolInfo }));
      }
    }

    return this.getEmptyPools();
  }

  private getRemotePoolInfo(registryAppId: uint64, validatorId: uint64): PoolInfo[] {
    return compileArc4(Reti).call.getPools({
      appId: registryAppId,
      args: [validatorId],
    }).returnValue;
  }

  private getEmptyPools(): ValidatorPoolInfo {
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
      log(encodeArc4(this.getRemoteNodePoolAssignments(registryAppId, validatorId)));
    }
    return this.getEmptyNodeAssignments();
  }

  private getRemoteNodePoolAssignments(registryAppId: uint64, validatorId: uint64): NodePoolAssignmentConfig {
    return compileArc4(Reti).call.getNodePoolAssignments({
      appId: registryAppId,
      args: [validatorId],
    }).returnValue;
  }

  private getEmptyNodeAssignments(): NodePoolAssignmentConfig {
    const n: NodeConfig = { poolAppIds: new FixedArray(new Uint64(0), new Uint64(0), new Uint64(0)) };
    return {
      nodes: new FixedArray(clone(n), clone(n), clone(n), clone(n), clone(n), clone(n), clone(n), clone(n)),
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getValidators(registryAppId: uint64, validatorIds: uint64[]): Validator {
    for (const validatorId of validatorIds) {
      const reti = compileArc4(Reti);

      const config = this.getRemoteValidatorConfig(registryAppId, validatorId);
      const state = this.getRemoteValidatorState(registryAppId, validatorId);
      const poolInfo = this.getRemotePoolInfo(registryAppId, validatorId);
      const nodeAssignment = this.getRemoteNodePoolAssignments(registryAppId, validatorId);

      const allPoolInfo: Validator = {
        config: clone(config),
        state: clone(state),
        poolInfo: clone(poolInfo),
        nodeAssignment: clone(nodeAssignment),
      };
      log(encodeArc4(allPoolInfo));
    }

    return {
      config: this.getEmptyConfig(),
      state: this.getEmptyState(),
      poolInfo: [this.getEmptyPools().poolInfo],
      nodeAssignment: this.getEmptyNodeAssignments(),
    };
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getBlockTimestamps(num: uint64): uint64 {
    for (let round: uint64 = Txn.lastValid - num - 1; round < Txn.firstValid - 1; round++) {
      log(op.Block.blkTimestamp(round));
    }
    return 0;
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getAlgodVersion(poolAppIds: uint64[]): string {
    for (const poolAppId of poolAppIds) {
      const [algodVer, exists] = op.AppGlobal.getExBytes(poolAppId, Bytes`algodVer`);
      if (exists) {
        log(encodeArc4(algodVer));
      } else {
        log(encodeArc4(""));
      }
    }
    return "";
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getAssets(assetIds: Asset[]): AssetInfo {
    for (const asset of assetIds) {
      const [creator, exists] = op.AssetParams.assetCreator(asset.id);
      if (!exists) {
        log(encodeArc4(this.getEmptyAssetInfo(asset.id)));
      } else {
        const assetInfo: AssetInfo = {
          assetId: asset.id,
          creator: creator,
          total: asset.total,
          decimals: new Uint8(asset.decimals),
          unitName: asset.unitName.toString(),
          name: asset.name.toString(),
        };
        log(encodeArc4(assetInfo));
      }
    }
    return this.getEmptyAssetInfo(0);
  }

  private getEmptyAssetInfo(assetId: uint64): AssetInfo {
    return {
      assetId: assetId,
      creator: Global.zeroAddress,
      total: 0,
      decimals: new Uint8(0),
      unitName: "",
      name: "",
    };
  }
}
