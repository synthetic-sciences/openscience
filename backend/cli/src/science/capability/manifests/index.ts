import { catalogManifests } from "./catalog"
import { coreManifests } from "./core"
import { bioNemoManifests } from "./bionemo"

export const capabilityManifests = { ...coreManifests, ...catalogManifests, ...bioNemoManifests } as const
