import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'avi',
  'mkv',
  'm4v',
  'mpg',
  'mpeg',
  'wmv',
  'webm',
  '3gp',
  'ts',
])

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE ?? 'ffprobe'
export const FONT = path.join(import.meta.dirname, 'B612Mono-Regular.ttf')

export type Logger = (message: string) => void

export type ConvertSummary = {
  converted: number
  renamed: number
  burned: number
  skipped: number
  errors: string[]
}

export function isVideoFile(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filename).slice(1).toLowerCase())
}

function emptySummary(): ConvertSummary {
  return { converted: 0, renamed: 0, burned: 0, skipped: 0, errors: [] }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

export async function listVideoFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && isVideoFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

export async function getCreationTime(filePath: string): Promise<string | null> {
  try {
    const stdout = await run(FFPROBE, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ])
    const metadata = JSON.parse(stdout)

    return (
      metadata?.format?.tags?.['com.apple.quicktime.creationdate'] ??
      metadata?.format?.tags?.creation_time ??
      metadata?.streams?.[0]?.tags?.creation_time ??
      null
    )
  } catch {
    return null
  }
}

async function getFormatTag(filePath: string, tag: string): Promise<string | null> {
  try {
    const stdout = await run(FFPROBE, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      filePath,
    ])
    return JSON.parse(stdout)?.format?.tags?.[tag] ?? null
  } catch {
    return null
  }
}

export function metadataToFileName(creationTime: string | null): string | null {
  if (!creationTime) return null
  const creationDate = new Date(creationTime)
  if (Number.isNaN(creationDate.getTime())) return null
  return `${creationDate.toISOString()}.mp4`
}

const PROCESSED_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.mp4$/i

/**
 * True when a file is already named after its creation time, e.g.
 * `2025-11-01T15:56:43.000Z.mp4`, which means it has been processed.
 */
export function isProcessedFileName(filePath: string): boolean {
  return PROCESSED_FILE_PATTERN.test(path.basename(filePath))
}

export function formatLabel(creationTime: string): string {
  const date = new Date(creationTime)
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Step 1: remux every non-mp4 video to mp4, keeping the streams untouched.
 * Files whose mp4 target already exists are left alone.
 */
async function convertToMp4(
  dir: string,
  files: string[],
  summary: ConvertSummary,
  log: Logger,
): Promise<string[]> {
  const result: string[] = []

  for (const [index, file] of files.entries()) {
    const inputPath = path.join(dir, file)

    if (file.toLowerCase().endsWith('.mp4')) {
      result.push(file)
      continue
    }

    const outputName = file.replace(/\.[^.]+$/, '.mp4')
    const outputPath = path.join(dir, outputName)

    if (await pathExists(outputPath)) {
      summary.skipped++
      log(`    ${file}: ${outputName} already exists, skipping (${index + 1}/${files.length})`)
      continue
    }

    log(`    ${file} (${index + 1}/${files.length})`)

    try {
      const creationTime = await getCreationTime(inputPath)
      const metadataArgs = creationTime ? ['-metadata', `creation_time=${creationTime}`] : []

      await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-map_metadata',
        '0',
        ...metadataArgs,
        '-movflags',
        'use_metadata_tags',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        outputPath,
      ])

      await rm(inputPath)
      summary.converted++
      result.push(outputName)
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {})
      summary.errors.push(`Failed to convert ${file}: ${errorMessage(error)}`)
      log(`    ERROR: Failed to convert ${file}, skipping`)
    }
  }

  return result
}

/**
 * Step 2: rename mp4s to their creation timestamp, e.g. `2025-11-01T15:56:43.000Z.mp4`.
 */
async function renameByCreationTime(
  dir: string,
  files: string[],
  summary: ConvertSummary,
  log: Logger,
): Promise<string[]> {
  const result: string[] = []

  for (const [index, file] of files.entries()) {
    if (!file.toLowerCase().endsWith('.mp4')) {
      result.push(file)
      continue
    }

    const filePath = path.join(dir, file)
    log(`    ${file} (${index + 1}/${files.length})`)

    try {
      const creationTime = await getCreationTime(filePath)
      const newFileName = metadataToFileName(creationTime)

      if (!newFileName || newFileName === file) {
        result.push(file)
        continue
      }

      const targetPath = path.join(dir, newFileName)
      if (await pathExists(targetPath)) {
        summary.skipped++
        log(`    ${file}: ${newFileName} already exists, keeping current name`)
        result.push(file)
        continue
      }

      await rename(filePath, targetPath)
      summary.renamed++
      result.push(newFileName)
    } catch (error) {
      summary.errors.push(`Failed to rename ${file}: ${errorMessage(error)}`)
      result.push(file)
    }
  }

  return result
}

/**
 * Step 3: burn the recording date into the bottom corner and tag the file with `burned=1`
 * so it is only done once.
 */
async function burnFilenameOverlay(
  dir: string,
  files: string[],
  summary: ConvertSummary,
  log: Logger,
): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (!file.toLowerCase().endsWith('.mp4')) continue

    const filePath = path.join(dir, file)

    if ((await getFormatTag(filePath, 'burned')) === '1') {
      summary.skipped++
      log(`    ${file}: already burned, skipping (${index + 1}/${files.length})`)
      continue
    }

    const creationTime = await getCreationTime(filePath)
    if (!creationTime) {
      summary.skipped++
      log(`    ${file}: no creation metadata, skipping (${index + 1}/${files.length})`)
      continue
    }

    const label = formatLabel(creationTime)
    const workingPath = path.join(dir, `.${file}.in_progress.mp4`)
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'filename-overlay-'))
    const textFile = path.join(tmpDir, 'label.txt')

    log(`    ${file} -> ${label} (${index + 1}/${files.length})`)

    try {
      await writeFile(textFile, label, 'utf8')

      const filter =
        `drawtext=fontfile=${escapeFilterValue(FONT)}` +
        `:textfile=${escapeFilterValue(textFile)}` +
        ':x=w/48:y=h/48:fontsize=sqrt(w*w+h*h)/42' +
        ':fontcolor=white'

      await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        filePath,
        '-map_metadata',
        '0',
        '-metadata',
        'burned=1',
        '-movflags',
        'use_metadata_tags',
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-crf',
        '18',
        '-preset',
        'fast',
        '-c:a',
        'copy',
        workingPath,
      ])

      await rm(filePath)
      await rename(workingPath, filePath)
      summary.burned++
    } catch (error) {
      summary.errors.push(`Failed to burn filename into ${file}: ${errorMessage(error)}`)
      log(`      ERROR: ${errorMessage(error)}`)
      await rm(workingPath, { force: true }).catch(() => {})
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function convertDirectoryFiles(
  dir: string,
  files: string[],
  summary: ConvertSummary,
  log: Logger,
): Promise<void> {
  const mp4Files = await convertToMp4(dir, files, summary, log)
  const renamedFiles = await renameByCreationTime(dir, mp4Files, summary, log)
  await burnFilenameOverlay(dir, renamedFiles, summary, log)
}

/** Runs the full pipeline over every video in one directory. */
export async function convertDirectory(
  dir: string,
  log: Logger = console.log,
): Promise<ConvertSummary> {
  const summary = emptySummary()
  const videoFiles = await listVideoFiles(dir)

  if (videoFiles.length === 0) {
    log('No video files found.')
    return summary
  }

  log(`Converted to mp4: ${videoFiles.filter((file) => !file.toLowerCase().endsWith('.mp4')).length} file(s)`)
  await convertDirectoryFiles(dir, videoFiles, summary, log)

  return summary
}

/** Runs the pipeline over a caller-provided list of files, grouped per directory. */
export async function convertFiles(
  rootDir: string,
  relativeFiles: string[],
  log: Logger = console.log,
): Promise<ConvertSummary> {
  const summary = emptySummary()
  const root = path.resolve(rootDir)
  const byDirectory = new Map<string, string[]>()

  for (const relative of relativeFiles) {
    const absolute = path.resolve(root, relative)
    const relativeToRoot = path.relative(root, absolute)

    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing to convert a file outside ${root}: ${relative}`)
    }
    if (!isVideoFile(absolute)) {
      throw new Error(`Not a video file: ${relative}`)
    }

    const dir = path.dirname(absolute)
    const filenames = byDirectory.get(dir) ?? []
    filenames.push(path.basename(absolute))
    byDirectory.set(dir, filenames)
  }

  for (const [dir, files] of byDirectory) {
    log(`Processing ${dir}`)
    await convertDirectoryFiles(dir, files, summary, log)
  }

  return summary
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const dir = process.argv[2] ?? process.env.MEDIA_DIR

  if (!dir) {
    console.error('Usage: node server/convert.ts <directory>')
    process.exit(1)
  }

  const summary = await convertDirectory(path.resolve(dir))
  console.log(summary)
  if (summary.errors.length > 0) process.exitCode = 1
}
