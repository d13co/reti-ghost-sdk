import { uint64 } from "@algorandfoundation/algorand-typescript";
import { Struct, StaticArray, Uint64, Uint8, Uint32, Uint16, Address, ARC4Encoded } from "@algorandfoundation/algorand-typescript/arc4";

export const MAX_POOLS_PER_NODE = 3; // max number of pools per node
export const MAX_NODES = 8;

export class NodeConfig extends Struct<{ poolAppIds: StaticArray<Uint64, typeof MAX_POOLS_PER_NODE> }> {}

export type NodePoolAssignmentConfig = {
  nodes: StaticArray<NodeConfig, typeof MAX_NODES>;
};

export type ValidatorConfig = {
  id: uint64; // id of this validator (sequentially assigned)
  owner: Address; // account that controls config - presumably cold-wallet
  manager: Address;
  nfdForInfo: uint64;
  entryGatingType: Uint8;
  entryGatingAddress: Address; // for GATING_TYPE_ASSETS_CREATED_BY
  entryGatingAssets: StaticArray<Uint64, 4>; // all checked for GATING_TYPE_ASSET_ID, only first used for GATING_TYPE_CREATED_BY_NFD_ADDRESSES, and GATING_TYPE_SEGMENT_OF_NFD
  gatingAssetMinBalance: uint64;
  rewardTokenId: uint64;
  rewardPerPayout: uint64;
  epochRoundLength: Uint32; // Number of rounds per epoch - ie: 30,857 for approx 24hrs w/ 2.8s round times
  percentToValidator: Uint32; // Payout percentage expressed w/ four decimals - ie: 50000 = 5% -> .0005 -
  validatorCommissionAddress: Address; // [CHANGEABLE] account that receives the validation commission each epoch payout (can be ZeroAddress)
  minEntryStake: uint64; // minimum stake required to enter pool - but must withdraw all if they want to go below this amount as well(!)
  maxAlgoPerPool: uint64; // maximum stake allowed per pool - if validator wants to restrict it.  0 means to use 'current' limits.
  poolsPerNode: Uint8; // Number of pools to allow per node (max of 3 is recommended)
  sunsettingOn: uint64; // [CHANGEABLE] timestamp when validator will sunset (if != 0)
  sunsettingTo: uint64; // [CHANGEABLE] validator id that validator is 'moving' to (if known)
};

export type ValidatorCurState = {
  numPools: Uint16; // current number of pools this validator has - capped at MaxPools
  totalStakers: uint64; // total number of stakers across all pools of THIS validator
  totalAlgoStaked: uint64; // total amount staked to this validator across ALL of its pools
  // amount of the reward token held back in pool 1 for paying out stakers their rewards.
  // as reward tokens are assigned to stakers - the amount as part of each epoch will be updated
  // in this value and this amount has to be assumed 'spent' - only reducing this number as the token
  // is actually sent out by request of the validator itself
  rewardTokenHeldBack: uint64;
};

export type PoolInfo = {
  poolAppId: uint64; // The App id of this staking pool contract instance
  totalStakers: Uint16;
  totalAlgoStaked: uint64;
};
