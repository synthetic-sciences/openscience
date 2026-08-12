import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_SOUND_VOLUME, clampSoundVolume, playSound, preloadSound } from "./sound"

class FakeAudio {
  static instances: FakeAudio[] = []

  currentTime = 12
  volume = 1
  preload = "none"
  pauseCount = 0
  playCount = 0
  loadCount = 0

  constructor(readonly src: string) {
    FakeAudio.instances.push(this)
  }

  pause() {
    this.pauseCount += 1
  }

  play() {
    this.playCount += 1
    return Promise.resolve()
  }

  load() {
    this.loadCount += 1
  }
}

const originalAudio = globalThis.Audio
const originalWindow = globalThis.window

beforeEach(() => {
  FakeAudio.instances = []
  Object.assign(globalThis, { Audio: FakeAudio })
  Object.assign(globalThis, {
    window: {
      matchMedia: () => ({ matches: false }),
    },
  })
})

afterEach(() => {
  Object.assign(globalThis, { Audio: originalAudio, window: originalWindow })
})

describe("audio feedback", () => {
  test("uses a subtle default volume, resets playback, and reuses the cached audio element", () => {
    playSound("/first.aac")
    playSound("/first.aac", 0.6)

    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0].preload).toBe("auto")
    expect(FakeAudio.instances[0].pauseCount).toBe(2)
    expect(FakeAudio.instances[0].playCount).toBe(2)
    expect(FakeAudio.instances[0].currentTime).toBe(0)
    expect(FakeAudio.instances[0].volume).toBe(0.6)
    expect(DEFAULT_SOUND_VOLUME).toBe(0.3)
  })

  test("preloads a chosen sound without starting playback", () => {
    preloadSound("/preload.aac")

    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0].loadCount).toBe(1)
    expect(FakeAudio.instances[0].playCount).toBe(0)
  })

  test("stays silent when reduced feedback is requested", () => {
    Object.assign(globalThis, {
      window: {
        matchMedia: () => ({ matches: true }),
      },
    })

    preloadSound("/quiet.aac")
    playSound("/quiet.aac")

    expect(FakeAudio.instances).toHaveLength(0)
  })

  test("clamps independent volume values", () => {
    expect(clampSoundVolume(-1)).toBe(0)
    expect(clampSoundVolume(2)).toBe(1)
    expect(clampSoundVolume(Number.NaN)).toBe(DEFAULT_SOUND_VOLUME)
  })
})
