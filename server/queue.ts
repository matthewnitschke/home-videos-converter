import { convertFiles, type ConvertSummary } from './convert.ts'

export type QueueItemStatus = 'queued' | 'running'

export type QueueItem = {
  id: number
  file: string
  status: QueueItemStatus
  addedAt: string
  startedAt: string | null
}

export type QueueError = {
  id: number
  file: string
  error: string
  failedAt: string
}

export type QueueCounts = {
  queued: number
  running: number
}

export type QueueSnapshot = {
  processing: boolean
  /** Total jobs finished since the server started (done or failed). */
  completed: number
  counts: QueueCounts
  /** Only active jobs; successful jobs are dropped from the queue. */
  items: QueueItem[]
  /** Recent failures stay visible until dismissed. */
  errors: QueueError[]
}

const MAX_ERRORS = 50

function summarize(summary: ConvertSummary): string {
  const parts: string[] = []
  if (summary.converted) parts.push(`${summary.converted} converted`)
  if (summary.renamed) parts.push(`${summary.renamed} renamed`)
  if (summary.burned) parts.push(`${summary.burned} burned`)
  if (summary.skipped) parts.push(`${summary.skipped} skipped`)
  return parts.length > 0 ? parts.join(', ') : 'Nothing to do'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * In-memory conversion queue with a single background worker. It only holds
 * jobs that are queued or running; finished jobs are removed, except for
 * failures which stay in `errors` until dismissed.
 */
export function createConvertQueue(rootDir: string) {
  const items: QueueItem[] = []
  const errors: QueueError[] = []
  let nextId = 1
  let processing = false
  let completed = 0

  function snapshot(): QueueSnapshot {
    const counts: QueueCounts = { queued: 0, running: 0 }
    for (const item of items) counts[item.status]++

    return {
      processing,
      completed,
      counts,
      items: items.map((item) => ({ ...item })),
      errors: errors.map((error) => ({ ...error })),
    }
  }

  function enqueue(files: string[]): QueueItem[] {
    const activeFiles = new Set(items.map((item) => item.file))
    const added: QueueItem[] = []

    for (const file of files) {
      if (activeFiles.has(file)) continue

      const item: QueueItem = {
        id: nextId++,
        file,
        status: 'queued',
        addedAt: new Date().toISOString(),
        startedAt: null,
      }

      items.push(item)
      activeFiles.add(file)
      added.push(item)
    }

    if (added.length > 0) {
      void drain()
    }

    return added
  }

  function dismissError(id: number): boolean {
    const index = errors.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    errors.splice(index, 1)
    return true
  }

  function recordError(item: QueueItem, message: string): void {
    errors.push({
      id: item.id,
      file: item.file,
      error: message,
      failedAt: new Date().toISOString(),
    })

    if (errors.length > MAX_ERRORS) {
      errors.splice(0, errors.length - MAX_ERRORS)
    }
  }

  async function drain(): Promise<void> {
    if (processing) return
    processing = true

    try {
      let item = items.find((entry) => entry.status === 'queued')

      while (item) {
        item.status = 'running'
        item.startedAt = new Date().toISOString()
        console.log(`[queue] converting ${item.file}`)

        try {
          const summary = await convertFiles(rootDir, [item.file])

          if (summary.errors.length > 0) {
            const message = summary.errors.join('; ')
            console.error(`[queue] ${item.file}: ${message}`)
            recordError(item, message)
          } else {
            console.log(`[queue] ${item.file}: ${summarize(summary)}`)
          }
        } catch (error) {
          const message = errorMessage(error)
          console.error(`[queue] ${item.file}: ${message}`)
          recordError(item, message)
        }

        const index = items.indexOf(item)
        if (index !== -1) items.splice(index, 1)
        completed++

        item = items.find((entry) => entry.status === 'queued')
      }
    } finally {
      processing = false
    }
  }

  return { enqueue, dismissError, snapshot }
}
