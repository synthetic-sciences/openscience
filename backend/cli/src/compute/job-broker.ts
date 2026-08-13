/**
 * The single public control-plane surface for detached research work.
 *
 * `ComputeJobs` is retained as the storage/runtime implementation name for
 * backwards compatibility. New tools and routes import this facade so local,
 * SSH, scheduler-through-SSH, and Modal work share one proposal, lifecycle,
 * recovery, cancellation, and result-harvest contract.
 */
export { ComputeJobs as JobBroker } from "./jobs"
