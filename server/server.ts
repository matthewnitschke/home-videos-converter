import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { FONT, isProcessedFileName, isVideoFile } from './convert.ts'
import { createConvertQueue } from './queue.ts'

const rootDir = path.resolve(import.meta.dirname, '..')
const frontendDir = path.join(rootDir, 'frontend')
const mediaDir = path.resolve(process.env.MEDIA_DIR ?? path.join(rootDir, 'data'))
const port = Number(process.env.PORT ?? 3000)

const app = new Hono()
const queue = createConvertQueue(mediaDir)

/** Walks the media directory and returns file paths relative to it. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries

  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // A missing media directory is an empty library; anything else is a real error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry): Promise<string[]> => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name

        if (entry.isDirectory()) return listFiles(path.join(dir, entry.name), relative)
        if (entry.isFile()) {
          // Already processed files are named after their creation time; leave them out.
          return isProcessedFileName(entry.name) ? [] : [relative]
        }
        return []
      }),
  )

  return nested.flat().sort((a, b) => a.localeCompare(b))
}

app.get('/api/files', async (c) => {
  const files = await listFiles(mediaDir)
  return c.json({ mediaDir, files })
})

// Adds files to the server-side queue; the response is the full queue state.
app.post('/api/convert', async (c) => {
  const body = await c.req.json().catch(() => null)
  const files = body?.files

  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => typeof file !== 'string')
  ) {
    return c.json({ error: 'Expected a non-empty "files" array of paths' }, 400)
  }

  const nonVideo = files.find((file) => !isVideoFile(file))
  if (nonVideo !== undefined) {
    return c.json({ error: `Not a video file: ${nonVideo}` }, 400)
  }

  const added = queue.enqueue(files)
  return c.json({ added: added.length, queue: queue.snapshot() }, 202)
})

app.get('/api/queue', (c) => c.json(queue.snapshot()))

app.delete('/api/queue/errors/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid error id' }, 400)

  const removed = queue.dismissError(id)
  if (!removed) return c.json({ error: 'Error not found' }, 404)

  return c.json({ queue: queue.snapshot() })
})

// Mithril straight from node_modules, so there is no build step.
app.use(
  '/vendor/mithril.js',
  serveStatic({ root: path.join(rootDir, 'node_modules', 'mithril'), path: 'mithril.min.js' }),
)

app.use('/*', serveStatic({ root: frontendDir }))

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Internal server error' }, 500)
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`home-videos-server listening on http://localhost:${info.port}`)
  console.log(`  media: ${mediaDir}`)
  console.log(`  font:  ${FONT}`)
})
