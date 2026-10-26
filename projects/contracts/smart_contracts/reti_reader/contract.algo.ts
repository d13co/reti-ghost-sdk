import {
  Application,
  assert,
  Asset,
  bytes,
  Bytes,
  clone,
  Contract,
  FixedArray,
  Global,
  log,
  op,
  Txn,
  uint64,
} from "@algorandfoundation/algorand-typescript";
import { AssetInfo, Constraints, MbrAmounts, NodeConfig, PoolInfo, StakedInfo, ValidatorConfig, ValidatorCurState } from "../reti/types.algo";
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
import { StakingPool } from "../reti/stakingPool.algo";

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
};

export type BalanceAndLastPayout = [uint64, uint64];

/** A round and its block timestamp. */
export type RoundAndTimestamp = [uint64, uint64];

/** A staking pool's global state and account balance. All zero, and `exists` false, if the pool app doesn't exist. */
export type PoolState = {
  poolAppId: uint64;
  exists: boolean;
  validatorId: uint64;
  poolId: uint64;
  numStakers: uint64;
  staked: uint64;
  minEntryStake: uint64;
  lastPayout: uint64;
  epochNumber: uint64;
  algodVer: string;
  roundsPerDay: uint64;
  binRoundStart: uint64;
  rewardAccumulator: uint64;
  /** uint128, big-endian; empty if unset */
  stakeAccumulator: bytes;
  /** uint128, big-endian; empty if unset. APY with four decimals (10000 = 1%) */
  ewma: bytes;
  balance: uint64;
  minBalance: uint64;
};

/** One of a staker's positions: the pool and the staker's entry in it. */
export type StakerPosition = {
  staker: Address;
  validatorId: uint64;
  poolId: uint64;
  poolAppId: uint64;
  info: StakedInfo;
};

export type AccountBalance = {
  account: Address;
  balance: uint64;
  minBalance: uint64;
};

export type AccountAsset = {
  account: Address;
  assetId: uint64;
};

export type AssetHolding = {
  account: Address;
  assetId: uint64;
  optedIn: boolean;
  balance: uint64;
};

/** The few validator numbers a chart needs. */
export type ValidatorTotals = {
  validatorId: uint64;
  numPools: uint64;
  totalStakers: uint64;
  totalAlgoStaked: uint64;
};

/** The registry's global totals; all zero if the registry doesn't exist. */
export type RegistryTotals = {
  numValidators: uint64;
  numStakers: uint64;
  staked: uint64;
};

/** The few pool numbers a chart needs. */
export type PoolTotals = {
  poolAppId: uint64;
  numStakers: uint64;
  staked: uint64;
};

export class RetiReader extends Contract {
  @baremethod({ allowActions: ["UpdateApplication", "DeleteApplication"] })
  adminOnly(): void {
    assert(Txn.sender === Global.creatorAddress);
  }

  /**
   * The registry's MBR amounts and protocol constraints.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getMbrAmountsAndProtocolConstraints(registryAppId: uint64): MbrAmountsAndProtocolConstraints {
    const reti = compileArc4(Reti);
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

  // stock: 16×8 refs per group, one taken by the registry app
  /**
   * Each validator's config, in order. `@ghostkit-chunk validatorIds refsPerItem=1 maxPerGroup=127`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorConfig(registryAppId: uint64, validatorIds: uint64[]): ValidatorConfig {
    for (const validatorId of validatorIds) {
      log(encodeArc4(this.getRemoteValidatorConfig(registryAppId, validatorId)));
    }
    return this.getEmptyConfig();
  }

  private getRemoteValidatorConfig(registryAppId: uint64, validatorId: uint64): ValidatorConfig {
    if (!this.validatorExists(registryAppId, validatorId)) return this.getEmptyConfig();
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

  // stock: 16×8 refs per group, one taken by the registry app
  /**
   * Each validator's current state, in order. `@ghostkit-chunk validatorIds refsPerItem=1 maxPerGroup=127`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorStates(registryAppId: uint64, validatorIds: uint64[]): ValidatorCurState {
    for (const validatorId of validatorIds) {
      log(encodeArc4(this.getRemoteValidatorState(registryAppId, validatorId)));
    }
    return this.getEmptyState();
  }

  private getRemoteValidatorState(registryAppId: uint64, validatorId: uint64): ValidatorCurState {
    if (!this.validatorExists(registryAppId, validatorId)) return this.getEmptyState();
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

  // stock: 16×8 refs per group, one taken by the registry app
  /**
   * Each validator's pools: one entry per pool, tagged with its validator id. `@ghostkit-chunk validatorIds refsPerItem=1 maxPerGroup=127`
   */
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
    if (!this.validatorExists(registryAppId, validatorId)) {
      const none: PoolInfo[] = [];
      return none;
    }
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

  // stock: 16×8 refs per group, one taken by the registry app
  /**
   * Each validator's node to pool assignments, in order. `@ghostkit-chunk validatorIds refsPerItem=1 maxPerGroup=127`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getNodePoolAssignments(registryAppId: uint64, validatorIds: uint64[]): NodePoolAssignmentConfig {
    for (const validatorId of validatorIds) {
      log(encodeArc4(this.getRemoteNodePoolAssignments(registryAppId, validatorId)));
    }
    return this.getEmptyNodeAssignments();
  }

  private getRemoteNodePoolAssignments(registryAppId: uint64, validatorId: uint64): NodePoolAssignmentConfig {
    if (!this.validatorExists(registryAppId, validatorId)) return this.getEmptyNodeAssignments();
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

  /**
   * Each validator's config, state, pools and node assignments, in order. `@ghostkit-chunk validatorIds refsPerItem=2 maxPerGroup=64`
   */
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

  /**
   * Timestamps of the `num` blocks before the first valid round, oldest first.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getBlockTimestamps(num: uint64): uint64 {
    for (let round: uint64 = Txn.lastValid - num - 1; round < Txn.firstValid - 1; round++) {
      log(op.Block.blkTimestamp(round));
    }
    return 0;
  }

  /**
   * The simulated round's block timestamp. Ghostkit sets first and last valid to one past the simulated round, so
   * that round is `Txn.firstValid - 1`. Unpinned, it's the newest block the call can read, near the latest round.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getRoundTimestamp(): uint64 {
    log(op.Block.blkTimestamp(Txn.firstValid - 1));
    return 0;
  }

  /**
   * The first round from `start` up to the simulated round whose block timestamp is at or after `target`, with that
   * timestamp; `[0, 0]` if there is none. `start` must be within the 1,000 rounds before the simulated round that a
   * program can read.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  firstRoundAtOrAfter(start: uint64, target: uint64): RoundAndTimestamp {
    const last: uint64 = Global.round - 1;
    for (let round: uint64 = start; round <= last; round++) {
      const timestamp = op.Block.blkTimestamp(round);
      if (timestamp >= target) {
        log(encodeArc4([round, timestamp] as RoundAndTimestamp));
        return [0, 0];
      }
    }
    log(encodeArc4([0, 0] as RoundAndTimestamp));
    return [0, 0];
  }

  /**
   * Each pool's reported algod version, or "" if it has none. `@ghostkit-chunk poolAppIds refsPerItem=1`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getAlgodVersion(poolAppIds: uint64[]): string {
    for (const poolAppId of poolAppIds) {
      if (this.notCreatedYet(poolAppId)) {
        log(encodeArc4(""));
        continue;
      }
      const [algodVer, exists] = op.AppGlobal.getExBytes(poolAppId, Bytes`algodVer`);
      if (exists) {
        log(encodeArc4(algodVer));
      } else {
        log(encodeArc4(""));
      }
    }
    return "";
  }

  /**
   * Each asset's params; a zero creator if the asset doesn't exist. `@ghostkit-chunk assetIds refsPerItem=1`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getAssets(assetIds: Asset[]): AssetInfo {
    for (const asset of assetIds) {
      if (this.notCreatedYet(asset.id)) {
        log(encodeArc4(this.getEmptyAssetInfo(asset.id)));
        continue;
      }
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

  /**
   * Each pool's balance and last payout round. `@ghostkit-chunk poolAppIds refsPerItem=2`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getPoolBalancesAndLastPayouts(poolAppIds: Application[]): BalanceAndLastPayout {
    for (const poolApp of poolAppIds) {
      if (this.notCreatedYet(poolApp.id)) {
        log(encodeArc4([0, 0] as BalanceAndLastPayout));
        continue;
      }
      const balance = op.balance(poolApp.address);
      const [lastPayout] = op.AppGlobal.getExUint64(poolApp, Bytes`lastPayout`);
      log(encodeArc4([balance, lastPayout] as BalanceAndLastPayout));
    }
    return [0, 0];
  }

  /**
   * Each pool's global state and account balance, in order. `@ghostkit-chunk pools refsPerItem=2`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getPoolStates(pools: Application[]): PoolState {
    for (const pool of pools) {
      log(encodeArc4(this.readPoolState(pool)));
    }
    return this.getEmptyPoolState(0);
  }

  private readPoolState(pool: Application): PoolState {
    if (this.notCreatedYet(pool.id)) return this.getEmptyPoolState(pool.id);
    const [, exists] = op.AppParams.appCreator(pool);
        const [balance] = op.AcctParams.acctBalance(pool.address);
    const [minBalance] = op.AcctParams.acctMinBalance(pool.address);
    return {
      poolAppId: pool.id,
      exists,
      validatorId: this.globalUint(pool, Bytes`validatorId`),
      poolId: this.globalUint(pool, Bytes`poolId`),
      numStakers: this.globalUint(pool, Bytes`numStakers`),
      staked: this.globalUint(pool, Bytes`staked`),
      minEntryStake: this.globalUint(pool, Bytes`minEntryStake`),
      lastPayout: this.globalUint(pool, Bytes`lastPayout`),
      epochNumber: this.globalUint(pool, Bytes`epochNumber`),
      algodVer: String(this.globalBytes(pool, Bytes`algodVer`)),
      roundsPerDay: this.globalUint(pool, Bytes`roundsPerDay`),
      binRoundStart: this.globalUint(pool, Bytes`binRoundStart`),
      rewardAccumulator: this.globalUint(pool, Bytes`rewardAccumulator`),
      stakeAccumulator: this.globalBytes(pool, Bytes`stakeAccumulator`),
      ewma: this.globalBytes(pool, Bytes`ewma`),
      balance,
      minBalance,
    };
  }

  private globalUint(app: Application, key: bytes): uint64 {
    const [value, exists] = op.AppGlobal.getExUint64(app, key);
    return exists ? value : 0;
  }

  /** A bytes global, or empty bytes if unset: a missing key reads as the uint 0. */
  private globalBytes(app: Application, key: bytes): bytes {
    const [value, exists] = op.AppGlobal.getExBytes(app, key);
    return exists ? value : Bytes``;
  }

  /**
   * Every position of each staker: one entry per pool the staker is in, stakers in order. `@ghostkit-chunk stakers refsPerItem=48 maxPerTxn=8 maxPerGroup=16`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getStakerPositions(registryAppId: uint64, stakers: Address[]): StakerPosition {
    for (const staker of stakers) {
      const keys = compileArc4(Reti).call.getStakedPoolsForAccount({
        appId: registryAppId,
        args: [staker],
      }).returnValue;
      for (const key of clone(keys)) {
        const info = compileArc4(StakingPool).call.getStakerInfo({
          appId: key.poolAppId,
          args: [staker],
        }).returnValue;
        log(encodeArc4({ staker, validatorId: key.id, poolId: key.poolId, poolAppId: key.poolAppId, info: clone(info) }));
      }
    }
    return {
      staker: new Address(),
      validatorId: 0,
      poolId: 0,
      poolAppId: 0,
      info: { account: new Address(), balance: 0, totalRewarded: 0, rewardTokenBalance: 0, entryRound: 0 },
    };
  }

  /**
   * Each account's balance and minimum balance, in order. Zero for accounts that don't exist. `@ghostkit-chunk accounts refsPerItem=1`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getAccountBalances(accounts: Address[]): AccountBalance {
    for (const account of accounts) {
      const [balance] = op.AcctParams.acctBalance(account.native);
      const [minBalance] = op.AcctParams.acctMinBalance(account.native);
      log(encodeArc4({ account, balance, minBalance }));
    }
    return { account: new Address(), balance: 0, minBalance: 0 };
  }

  /**
   * Each account's holding of an asset, in order. `@ghostkit-chunk holdings refsPerItem=3`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getAssetHoldings(holdings: AccountAsset[]): AssetHolding {
    for (const holding of clone(holdings)) {
      const [balance, optedIn] = op.AssetHolding.assetBalance(holding.account.native, holding.assetId);
      log(encodeArc4({ account: holding.account, assetId: holding.assetId, optedIn, balance }));
    }
    return { account: new Address(), assetId: 0, optedIn: false, balance: 0 };
  }

  // stock: 16×8 refs per group, one taken by the registry app
  /**
   * Each validator's pool count, stakers and stake, in order: a small read for charts. `@ghostkit-chunk validatorIds refsPerItem=1 maxPerGroup=127`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getValidatorTotals(registryAppId: uint64, validatorIds: uint64[]): ValidatorTotals {
    for (const validatorId of validatorIds) {
      const state = this.getRemoteValidatorState(registryAppId, validatorId);
      log(
        encodeArc4({
          validatorId,
          numPools: state.numPools.asUint64(),
          totalStakers: state.totalStakers,
          totalAlgoStaked: state.totalAlgoStaked,
        }),
      );
    }
    return { validatorId: 0, numPools: 0, totalStakers: 0, totalAlgoStaked: 0 };
  }

  /**
   * The registry's validator count, total stakers and total stake, from its global state: a small read for charts.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getRegistryTotals(registryAppId: uint64): RegistryTotals {
    const [numValidators] = op.AppGlobal.getExUint64(registryAppId, Bytes`numV`);
    const [numStakers] = op.AppGlobal.getExUint64(registryAppId, Bytes`numStakers`);
    const [staked] = op.AppGlobal.getExUint64(registryAppId, Bytes`staked`);
    log(encodeArc4({ numValidators, numStakers, staked }));
    return { numValidators: 0, numStakers: 0, staked: 0 };
  }

  /**
   * Each pool's stakers and stake, in order: a small read for charts. `@ghostkit-chunk pools refsPerItem=1`
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getPoolTotals(pools: Application[]): PoolTotals {
    for (const pool of pools) {
      if (this.notCreatedYet(pool.id)) {
        const none: PoolTotals = { poolAppId: pool.id, numStakers: 0, staked: 0 };
        log(encodeArc4(none));
        continue;
      }
      log(
        encodeArc4({
          poolAppId: pool.id,
          numStakers: this.globalUint(pool, Bytes`numStakers`),
          staked: this.globalUint(pool, Bytes`staked`),
        }),
      );
    }
    return { poolAppId: 0, numStakers: 0, staked: 0 };
  }

  /** Whether a validator exists in the registry: ids run from 1 to the registry's `numV`. */
  private validatorExists(registryAppId: uint64, validatorId: uint64): boolean {
    const [numV] = op.AppGlobal.getExUint64(registryAppId, Bytes`numV`);
    return validatorId >= 1 && validatorId <= numV;
  }

  /**
   * Whether an app or asset id hadn't been created yet at the simulated round. Apps and assets share one id counter,
   * and the ghost being created takes the next id, so every id at or above the ghost's own didn't exist yet. Reading
   * such an id would fail the call. Only known while the ghost is being created; a deployed reader returns false.
   */
  private notCreatedYet(id: uint64): boolean {
    return Txn.applicationId.id === 0 && id >= Global.currentApplicationId.id;
  }

  private getEmptyPoolState(poolAppId: uint64): PoolState {
    return {
      poolAppId,
      exists: false,
      validatorId: 0,
      poolId: 0,
      numStakers: 0,
      staked: 0,
      minEntryStake: 0,
      lastPayout: 0,
      epochNumber: 0,
      algodVer: "",
      roundsPerDay: 0,
      binRoundStart: 0,
      rewardAccumulator: 0,
      stakeAccumulator: Bytes``,
      ewma: Bytes``,
      balance: 0,
      minBalance: 0,
    };
  }
}
