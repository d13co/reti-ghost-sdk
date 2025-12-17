import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiFastSDK } from "."

const registryAppId = 2714516089

const sdk = new RetiFastSDK({
  algorand: AlgorandClient.fromEnvironment(),
  registryAppId,
})

;(async () => {
  console.time("run")
  const numValidators = await sdk.getNumValidators()
  const validatorIds = new Array(numValidators).fill(0).map((_, i) => i + 1)

  const x = sdk.getValidatorConfig(validatorIds).then((configs) => {
    console.log("Retrieved validator configs:", configs.length)
    console.log("Sample", configs[0])
    console.log("  --")
  })

  const y = sdk.getValidatorStates(validatorIds).then((states) => {
    console.log("Retrieved validator states:", states.length)
    console.log("Sample", states[0])
    console.log("  --")
  })

  const z = sdk.getPools(validatorIds).then((pools) => {
    console.log("Retrieved pools:", pools.length)
    console.log("Samples 1 63 95 96", pools[0], pools[62], pools[94], pools[95])
    console.log("  --")
    // at time of writing:
    // validator id 63 has 0
    // validator id 95 has 3
    // validator id 96 has 1
  })

  await Promise.all([x, y, z])
  console.timeEnd("run")
})()
