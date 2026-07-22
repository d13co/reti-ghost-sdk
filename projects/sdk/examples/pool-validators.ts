import { getApplicationAddress } from "algosdk"
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "../src"

const registryAppId = 2714516089

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId,
})

;(async () => {
  console.time("run")
  const numValidators = await sdk.getNumValidators()
  const validatorIds = new Array(numValidators).fill(0).map((_, i) => i + 1)

  const poolsWithValidatorId = (await sdk.getPools(validatorIds))
    .map((pools, i) => ({
      validatorId: validatorIds[i],
      pools: pools.map(p => ({
        poolAppEscrow: getApplicationAddress(p.poolAppId).toString(),
        ...p, 
      }))
    }))
  console.log(poolsWithValidatorId[136]);
  console.timeEnd("run")
})()
