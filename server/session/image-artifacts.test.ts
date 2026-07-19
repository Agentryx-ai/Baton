import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ImageArtifactError, LocalImageArtifactStore, parseImageArtifactRef } from './image-artifacts.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('stores immutable content-addressed PNG artifacts without embedding bytes in the reference', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'baton-images-'))
  const store = new LocalImageArtifactStore(root)
  const first = store.put(PNG, 'image/png', 'screen.png', 'upload')
  const second = store.put(PNG, 'image/png', 'other.png', 'ldplayer_capture')

  assert.equal(first.id, second.id)
  assert.equal(first.width, 1)
  assert.equal(first.height, 1)
  assert.equal(readFileSync(store.pathFor(first)).equals(PNG), true)
  assert.match(store.dataUrl(first), /^data:image\/png;base64,/)
  assert.equal(JSON.stringify(first).includes(PNG.toString('base64')), false)
  assert.deepEqual(parseImageArtifactRef(first), first)
})

test('rejects declared image types that do not match their bytes', () => {
  const store = new LocalImageArtifactStore(mkdtempSync(path.join(tmpdir(), 'baton-images-')))
  assert.throws(
    () => store.put(Buffer.from('not an image'), 'image/png', 'fake.png', 'upload'),
    (error: unknown) => error instanceof ImageArtifactError && error.code === 'invalid_image',
  )
})
