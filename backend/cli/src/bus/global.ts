import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory?: string
      payload: any
    },
  ]
}>()

// Every /global/event client and every project subscriber adds a listener, so
// the default 10-listener cap would only print spurious leak warnings.
GlobalBus.setMaxListeners(0)
