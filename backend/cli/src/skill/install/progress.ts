export interface ProgressEvent {
  kind: "start" | "update" | "done"
  msg: string
}

export class Progress {
  private listeners: ((e: ProgressEvent) => void)[] = []

  static silent(): Progress {
    return new Progress(false)
  }

  static interactive(): Progress {
    return new Progress(true)
  }

  private constructor(private renderToStdout: boolean) {}

  onEvent(fn: (e: ProgressEvent) => void): void {
    this.listeners.push(fn)
  }

  start(msg: string): void {
    this.emit({ kind: "start", msg })
    if (this.renderToStdout) {
      process.stdout.write(`✓ ${msg}\n`)
    }
  }

  update(msg: string): void {
    this.emit({ kind: "update", msg })
    if (this.renderToStdout) {
      process.stdout.write(`\r⠋ ${msg} …`)
    }
  }

  done(msg: string): void {
    this.emit({ kind: "done", msg })
    if (this.renderToStdout) {
      process.stdout.write(`\r✓ ${msg}\n`)
    }
  }

  private emit(e: ProgressEvent): void {
    for (const fn of this.listeners) fn(e)
  }
}
