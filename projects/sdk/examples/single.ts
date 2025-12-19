import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from ".."
import { chunk } from "../src/utils/chunk";
import pMap from "p-map";

const registryAppId = 2714516089

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId,
})

;(async () => {
  console.time("run")

  const numValidators = await sdk.getNumValidators()
  const validatorIds = Array(numValidators).fill(0).map((_, i) => i+1)
  const data = await sdk.getValidators(validatorIds)

  console.timeEnd("run")
  console.log("Sample:", data[0])
})()
