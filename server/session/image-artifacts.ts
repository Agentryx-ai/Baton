import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MAX_IMAGE_ARTIFACT_BYTES = 10 * 1024 * 1024

export interface ImageArtifactRef {
  id: string
  sha256: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  byteLength: number
  width: number | null
  height: number | null
  fileName: string
  source: 'upload' | 'tool_capture'
}

export interface ImageArtifactResolver {
  pathFor(ref: ImageArtifactRef): string
  dataUrl(ref: ImageArtifactRef): string
}

export interface StoredImageArtifact {
  mediaType: ImageArtifactRef['mediaType']
  buffer: Buffer
}

const EXTENSIONS: Readonly<Record<ImageArtifactRef['mediaType'], string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

export class LocalImageArtifactStore implements ImageArtifactResolver {
  readonly #root: string

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Image artifact root must be absolute')
    this.#root = path.resolve(root)
    mkdirSync(this.#root, { recursive: true })
  }

  put(input: Buffer, mediaType: ImageArtifactRef['mediaType'], fileName: string, source: ImageArtifactRef['source']): ImageArtifactRef {
    if (input.length < 1 || input.length > MAX_IMAGE_ARTIFACT_BYTES) {
      throw new ImageArtifactError('invalid_image_size', `Image must contain 1..${MAX_IMAGE_ARTIFACT_BYTES} bytes`)
    }
    const dimensions = inspectImage(input, mediaType)
    const sha256 = createHash('sha256').update(input).digest('hex')
    const id = `sha256-${sha256}`
    const target = path.join(this.#root, `${id}${EXTENSIONS[mediaType]}`)
    if (!existsSync(target)) {
      const temporary = path.join(this.#root, `.${id}.${process.pid}.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, input, { flag: 'wx', flush: true })
        try {
          renameSync(temporary, target)
        } catch (error) {
          if (!existsSync(target)) throw error
        }
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    const stored = readFileSync(target)
    if (stored.length !== input.length || createHash('sha256').update(stored).digest('hex') !== sha256) {
      throw new ImageArtifactError('artifact_integrity_error', 'Stored image artifact failed integrity verification')
    }
    return Object.freeze({
      id,
      sha256,
      mediaType,
      byteLength: input.length,
      width: dimensions.width,
      height: dimensions.height,
      fileName: safeFileName(fileName, EXTENSIONS[mediaType]),
      source,
    })
  }

  pathFor(ref: ImageArtifactRef): string {
    validateRef(ref as unknown as Record<string, unknown>)
    const artifactPath = path.join(this.#root, `${ref.id}${EXTENSIONS[ref.mediaType]}`)
    const buffer = readFileSync(artifactPath)
    if (buffer.length !== ref.byteLength || createHash('sha256').update(buffer).digest('hex') !== ref.sha256) {
      throw new ImageArtifactError('artifact_integrity_error', 'Image artifact no longer matches its canonical reference')
    }
    return artifactPath
  }

  dataUrl(ref: ImageArtifactRef): string {
    return `data:${ref.mediaType};base64,${readFileSync(this.pathFor(ref)).toString('base64')}`
  }

  readById(id: string): StoredImageArtifact {
    if (!/^sha256-[a-f0-9]{64}$/.test(id)) {
      throw new ImageArtifactError('invalid_image_ref', 'Image artifact ID is invalid')
    }
    for (const [mediaType, extension] of Object.entries(EXTENSIONS) as Array<[ImageArtifactRef['mediaType'], string]>) {
      const candidate = path.join(this.#root, `${id}${extension}`)
      if (!existsSync(candidate)) continue
      const buffer = readFileSync(candidate)
      if (`sha256-${createHash('sha256').update(buffer).digest('hex')}` !== id) {
        throw new ImageArtifactError('artifact_integrity_error', 'Image artifact failed integrity verification')
      }
      return { mediaType, buffer }
    }
    throw new ImageArtifactError('artifact_not_found', 'Image artifact was not found')
  }
}

export class ImageArtifactError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImageArtifactError'
    this.code = code
  }
}

export function parseImageArtifactRef(value: unknown): ImageArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImageArtifactError('invalid_image_ref', 'Image reference must be an object')
  }
  const ref = value as Record<string, unknown>
  const parsed = {
    id: ref.id,
    sha256: ref.sha256,
    mediaType: ref.mediaType,
    byteLength: ref.byteLength,
    width: ref.width,
    height: ref.height,
    fileName: ref.fileName,
    // Normalize references produced by the retired core emulator adapter.
    source: ref.source === 'ldplayer_capture' ? 'tool_capture' : ref.source,
  }
  validateRef(parsed)
  return Object.freeze(parsed as ImageArtifactRef)
}

export function imageAttachments(payload: Record<string, unknown>): ImageArtifactRef[] {
  if (payload.attachments === undefined) return []
  if (!Array.isArray(payload.attachments) || payload.attachments.length < 1 || payload.attachments.length > 8) {
    throw new ImageArtifactError('invalid_image_ref', 'attachments must contain 1..8 image references')
  }
  return payload.attachments.map(parseImageArtifactRef)
}

export function hasPortableUserContent(payload: Record<string, unknown>): boolean {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  try {
    return text.length > 0 || imageAttachments(payload).length > 0
  } catch {
    return false
  }
}

function validateRef(value: Record<string, unknown>): void {
  if (typeof value.id !== 'string' || typeof value.sha256 !== 'string'
    || !/^sha256-[a-f0-9]{64}$/.test(value.id) || value.id !== `sha256-${value.sha256}`) {
    throw new ImageArtifactError('invalid_image_ref', 'Image reference identity is invalid')
  }
  if (value.mediaType !== 'image/png' && value.mediaType !== 'image/jpeg'
    && value.mediaType !== 'image/webp' && value.mediaType !== 'image/gif') {
    throw new ImageArtifactError('invalid_image_ref', 'Image media type is unsupported')
  }
  if (!Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1
    || Number(value.byteLength) > MAX_IMAGE_ARTIFACT_BYTES) {
    throw new ImageArtifactError('invalid_image_ref', 'Image byte length is invalid')
  }
  for (const dimension of [value.width, value.height]) {
    if (dimension !== null && (!Number.isSafeInteger(dimension) || Number(dimension) < 1 || Number(dimension) > 16_384)) {
      throw new ImageArtifactError('invalid_image_ref', 'Image dimensions are invalid')
    }
  }
  if (typeof value.fileName !== 'string' || value.fileName.length < 1 || value.fileName.length > 255
    || (value.source !== 'upload' && value.source !== 'tool_capture')) {
    throw new ImageArtifactError('invalid_image_ref', 'Image metadata is invalid')
  }
}

function inspectImage(buffer: Buffer, mediaType: ImageArtifactRef['mediaType']): { width: number | null; height: number | null } {
  if (mediaType === 'image/png') {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new ImageArtifactError('invalid_image', 'PNG signature is invalid')
    }
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
      throw new ImageArtifactError('invalid_image', 'PNG dimensions are invalid')
    }
    return { width, height }
  }
  if (mediaType === 'image/jpeg' && (buffer[0] !== 0xff || buffer[1] !== 0xd8)) {
    throw new ImageArtifactError('invalid_image', 'JPEG signature is invalid')
  }
  if (mediaType === 'image/gif' && !buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    throw new ImageArtifactError('invalid_image', 'GIF signature is invalid')
  }
  if (mediaType === 'image/webp'
    && (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP')) {
    throw new ImageArtifactError('invalid_image', 'WebP signature is invalid')
  }
  return { width: null, height: null }
}

function safeFileName(fileName: string, extension: string): string {
  const leaf = Array.from(path.basename(fileName).replace(/[<>:"/\\|?*]/g, '_'))
    .map((character) => character.codePointAt(0)! < 32 ? '_' : character)
    .join('')
    .trim()
  return (leaf || `image${extension}`).slice(0, 255)
}
