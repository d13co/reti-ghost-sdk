import type { AlgorandClient } from "@algorandfoundation/algokit-utils"

/** A read at a round before the Reti registry was created. */
export class RetiNotDeployedError extends Error {
  readonly round: bigint
  readonly creationRound: bigint

  constructor(round: bigint, creationRound: bigint) {
    super(`The Reti registry didn't exist at round ${round}: it was created at round ${creationRound}`)
    this.name = "RetiNotDeployedError"
    this.round = round
    this.creationRound = creationRound
  }
}

/**
 * A read at a past round on a node without time travel. Such a node reads only the latest state, which the SDK uses
 * for rounds near its latest round.
 */
export class TimeTravelUnavailableError extends Error {
  readonly round: bigint
  readonly lastRound: bigint

  constructor(round: bigint, lastRound: bigint, reason: string) {
    super(
      `Reading at round ${round} needs a dtalgorand node with time travel and the dtalgorand forks of algosdk and ` +
        `algokit-utils (${reason}); this node only reads the latest state, used for rounds near its latest (${lastRound})`,
    )
    this.name = "TimeTravelUnavailableError"
    this.round = round
    this.lastRound = lastRound
  }
}

/** A read at a round the node hasn't reached yet. */
export class FutureRoundError extends Error {
  readonly round: bigint
  readonly lastRound: bigint

  constructor(round: bigint, lastRound: bigint) {
    super(`Round ${round} isn't on this node yet: its latest round is ${lastRound}`)
    this.name = "FutureRoundError"
    this.round = round
    this.lastRound = lastRound
  }
}

/** Whether an error means the node or the loaded libraries don't support a dtalgorand feature. */
export function isDTUnsupported(e: unknown): boolean {
  const name = (e as { name?: string } | undefined)?.name
  return name === "DTUnsupportedError" || name === "DTNotAvailableError"
}

/**
 * A dtalgorand read with a stock algokit-utils, which has no `algorand.dt`. `isDTUnsupported` is true for it. It is
 * reti's own class with the name of utils' error: importing that class would fail to link with stock algokit-utils.
 */
export class DTNotAvailableError extends Error {
  constructor(what: string) {
    super(`${what} needs the dtalgorand fork of algokit-utils (algorand.dt)`)
    this.name = "DTNotAvailableError"
  }
}

/** `algorand.dt`; throws `DTNotAvailableError` when algokit-utils isn't the dtalgorand fork. `what` names the read. */
export function requireDT(algorand: AlgorandClient, what: string): AlgorandClient["dt"] {
  // `algorand.dt` only exists on the dtalgorand fork of algokit-utils
  const dt = (algorand as Partial<Pick<AlgorandClient, "dt">>).dt
  if (!dt) throw new DTNotAvailableError(what)
  return dt
}
