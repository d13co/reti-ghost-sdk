import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from ".."
import { chunk } from "../utils/chunk";
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
  const chunks = chunk(validatorIds, 64)
  await pMap(chunks, async (ids, i) => {
    console.time(`getValidators(${i})`)
    const data = await sdk.getValidators(ids)
    console.timeEnd(`getValidators(${i})`)
  }, { concurrency: 2 })

  console.timeEnd("run")
})()
