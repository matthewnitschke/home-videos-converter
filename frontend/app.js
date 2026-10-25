const m = window.m

const POLL_INTERVAL = 2000

const state = {
  files: null,
  mediaDir: null,
  loading: false,
  selected: new Set(),
  queue: null,
  enqueueing: false,
  enqueueError: null,
  error: null,
}

let lastCompleted = 0
let pollTimer = null
let clockTimer = null

async function loadFiles() {
  state.loading = true
  state.error = null

  try {
    const response = await fetch('/api/files')
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    const data = await response.json()
    state.files = data.files
    state.mediaDir = data.mediaDir

    // Drop selections for files that no longer exist.
    const existing = new Set(data.files)
    for (const file of state.selected) {
      if (!existing.has(file)) state.selected.delete(file)
    }
  } catch (error) {
    state.error = error.message
  } finally {
    state.loading = false
    m.redraw()
  }
}

function applyQueue(next, { refreshFiles = true } = {}) {
  const previous = state.queue
  state.queue = next

  if (refreshFiles && next.completed !== lastCompleted) {
    // Files can be renamed or converted, so refresh the listing.
    lastCompleted = next.completed
    loadFiles()
  }

  if (JSON.stringify(previous) !== JSON.stringify(next)) m.redraw()
}

async function loadQueue() {
  try {
    const response = await fetch('/api/queue')
    if (!response.ok) return
    applyQueue(await response.json())
  } catch {
    // Ignore transient polling errors; the next tick tries again.
  }
}

async function enqueueSelected() {
  const files = [...state.selected]
  if (files.length === 0) return

  state.enqueueing = true
  state.enqueueError = null

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)

    state.selected.clear()
    if (data.queue) applyQueue(data.queue, { refreshFiles: false })
  } catch (error) {
    state.enqueueError = error.message
  } finally {
    state.enqueueing = false
    m.redraw()
  }
}

async function dismissError(id) {
  try {
    const response = await fetch(`/api/queue/errors/${id}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    const data = await response.json()
    applyQueue(data.queue, { refreshFiles: false })
  } catch {
    // Leave it in place; the next poll will resync.
  }
}

function toggleFile(file, checked) {
  if (checked) state.selected.add(file)
  else state.selected.delete(file)
}

function allFilesSelected() {
  const files = state.files ?? []
  return files.length > 0 && files.every((file) => state.selected.has(file))
}

function someFilesSelected() {
  const files = state.files ?? []
  return !allFilesSelected() && files.some((file) => state.selected.has(file))
}

function setAllSelected(checked) {
  if (!checked) {
    state.selected.clear()
    return
  }

  for (const file of state.files ?? []) state.selected.add(file)
}

function isActive(item) {
  return item.status === 'queued' || item.status === 'running'
}

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Converting…',
}

function formatElapsed(startedAt) {
  if (!startedAt) return '0:00'

  const totalSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value) => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

const RunQueue = {
  view() {
    const queue = state.queue
    if (!queue || queue.items.length === 0) return null

    const { queued, running } = queue.counts

    return m('section.card.queue', [
      m('.queue-head', [
        m('div', [
          m('strong', 'Run queue'),
          m(
            'span.subtle',
            ` ${running} converting, ${queued} queued` +
              (queue.processing ? '' : ' (paused)'),
          ),
          queue.processing ? m('span.live', '● live') : null,
        ]),
      ]),

      m(
        'ul.queue-items',
        queue.items.map((item) =>
          m(`li.queue-item.${item.status}`, { key: item.id }, [
            m('span.queue-file', item.file),
            m('span.queue-meta', [
              item.status === 'running'
                ? m('span.queue-time', { title: 'Time converting' }, formatElapsed(item.startedAt))
                : null,
              m('span.queue-status', STATUS_LABELS[item.status]),
            ]),
          ]),
        ),
      ),
    ])
  },
}

const QueueErrors = {
  view() {
    const queue = state.queue
    if (!queue || queue.errors.length === 0) return null

    return m('section.card.errors', [
      m('.queue-head', [
        m('strong', `Error${queue.errors.length === 1 ? '' : 's'}`),
      ]),
      m(
        'ul.queue-items',
        queue.errors.map((item) =>
          m('li.queue-item.error', { key: item.id }, [
            m('span.queue-file', item.file),
            m(
              'button.dismiss',
              {
                type: 'button',
                title: 'Dismiss error',
                'aria-label': `Dismiss error for ${item.file}`,
                onclick: () => dismissError(item.id),
              },
              'Dismiss',
            ),
            m('span.queue-detail', item.error),
          ]),
        ),
      ),
    ])
  },
}

const App = {
  async oninit() {
    await Promise.all([loadFiles(), loadQueue()])
    lastCompleted = state.queue ? state.queue.completed : 0

    pollTimer = setInterval(loadQueue, POLL_INTERVAL)
    clockTimer = setInterval(() => {
      const running = (state.queue?.items ?? []).some((item) => item.status === 'running')
      if (running) m.redraw()
    }, 1000)
  },

  onremove() {
    if (pollTimer !== null) clearInterval(pollTimer)
    if (clockTimer !== null) clearInterval(clockTimer)
  },

  view() {
    const selectedCount = state.selected.size
    const allSelected = allFilesSelected()
    const someSelected = someFilesSelected()
    const queuedFiles = new Set(
      (state.queue?.items ?? []).filter(isActive).map((item) => item.file),
    )

    return m('main', [
      m('h1', 'Home Videos'),
      m(
        'p',
        state.mediaDir
          ? `${state.files?.length ?? 0} files in ${state.mediaDir}`
          : 'Files in the library',
      ),

      m(RunQueue),
      m(QueueErrors),

      m('.card', [
        state.error
          ? m('p.message', state.error)
          : state.files === null
            ? m('p.message', 'Loading…')
            : state.files.length === 0
              ? m('p.message', 'No files found.')
              : [
                  m('.list-head', [
                    m('label.select-all', [
                      m('input', {
                        type: 'checkbox',
                        checked: allSelected,
                        oncreate: (vnode) => {
                          vnode.dom.indeterminate = someSelected
                        },
                        onupdate: (vnode) => {
                          vnode.dom.indeterminate = someSelected
                        },
                        onchange: (event) => setAllSelected(event.target.checked),
                      }),
                      m('span', 'Select all'),
                    ]),
                    m('span.subtle', `${selectedCount} selected`),
                  ]),

                  m(
                    'ul.files',
                    state.files.map((file) =>
                      m(
                        'li',
                        { key: file },
                        m('label', [
                          m('input', {
                            type: 'checkbox',
                            checked: state.selected.has(file),
                            onchange: (event) => toggleFile(file, event.target.checked),
                          }),
                          m('span', file),
                          queuedFiles.has(file) ? m('span.queue-tag', 'queued') : null,
                        ]),
                      ),
                    ),
                  ),
                ],

        m('.toolbar', [
          m('span.subtle', `${selectedCount} selected`),
          m(
            'button',
            {
              type: 'button',
              disabled: selectedCount === 0 || state.enqueueing || state.loading,
              onclick: enqueueSelected,
            },
            state.enqueueing ? 'Adding…' : 'Convert',
          ),
        ]),

        state.enqueueError
          ? m('p.status.error', { role: 'status' }, state.enqueueError)
          : null,
      ]),
    ])
  },
}

m.mount(document.getElementById('app'), App)
