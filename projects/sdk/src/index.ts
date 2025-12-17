import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiReaderSDK, ValidatorConfig, ValidatorCurState, ValidatorPoolInfo } from "./generated/RetiReaderSDK.js"
import { chunked } from "./utils/chunked.js"

export class RetiFastSDK {
  public algorand: AlgorandClient
  public registryAppId: bigint
  private ghostSDK: RetiReaderSDK

  constructor({ algorand, registryAppId }: { algorand: AlgorandClient; registryAppId: number | bigint }) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.ghostSDK = new RetiReaderSDK({ algorand: this.algorand })
  }

  async getNumValidators(): Promise<number> {
    const { numV } = await this.algorand.app.getGlobalState(this.registryAppId)
    return Number(numV.value)
  }

  @chunked(127)
  async getValidatorConfig(validatorIds: number[] | bigint[]): Promise<ValidatorConfig[]> {
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getValidatorConfig({ registryAppId: this.registryAppId, validatorIds }, { extraFee })
  }

  @chunked(127)
  async getValidatorStates(validatorIds: number[] | bigint[]): Promise<ValidatorCurState[]> {
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getValidatorStates({ registryAppId: this.registryAppId, validatorIds }, { extraFee })
  }

  async getPools(validatorIds: number[] | bigint[]): Promise<ValidatorPoolInfo["poolInfo"][][]> {
    const results = await this._internal_getPoolInfo(validatorIds)
    return validatorIds.map((vid) =>
      results
        .filter((r) => r.validatorId === BigInt(vid))
        .map((r) => r.poolInfo)
    )
  }

  @chunked(127)
  private async _internal_getPoolInfo(validatorIds: number[] | bigint[]): Promise<ValidatorPoolInfo[]> {
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getPools({ registryAppId: this.registryAppId, validatorIds }, { extraFee })
  }
}
