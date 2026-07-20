import { Router } from 'express'

import {
  NativeFolderPickerError,
  pickNativeFolder,
} from './session/native-folder-picker.ts'

const INTERACTION_HEADER = 'x-baton-interaction'
const FOLDER_PICKER_INTERACTION = 'native-folder-picker'

export interface HostRouteOptions {
  pickFolder?: (initialDirectory?: string | null) => Promise<string | null>
}

export function createHostRouter(options: HostRouteOptions = {}): Router {
  const router = Router()
  const pickFolder = options.pickFolder
    ?? ((initialDirectory?: string | null) => pickNativeFolder({ initialDirectory }))

  router.post('/baton/host/folders/pick', async (req, res) => {
    if (req.get(INTERACTION_HEADER) !== FOLDER_PICKER_INTERACTION) {
      res.status(403).json({ code: 'interaction_required', error: 'Explicit native folder interaction is required' })
      return
    }
    try {
      const cwd = await pickFolder(requestedInitialDirectory(req.body))
      res.json(cwd === null ? { status: 'cancelled' } : { status: 'selected', cwd })
    } catch (error) {
      if (error instanceof NativeFolderPickerError) {
        res.status(folderPickerStatus(error.code)).json({ code: error.code, error: error.message })
        return
      }
      res.status(500).json({ code: 'picker_failed', error: 'The native folder picker failed' })
    }
  })

  return router
}

/** Body arrives as a raw Buffer (global express.raw); the suggestion is optional and advisory. */
function requestedInitialDirectory(body: unknown): string | null {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 4096) return null
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const cwd = (parsed as Record<string, unknown>).cwd
      if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd
    }
  } catch {
    /* malformed body: open the picker without a suggestion */
  }
  return null
}

function folderPickerStatus(code: NativeFolderPickerError['code']): number {
  if (code === 'unsupported_os' || code === 'invalid_picker_response') return 400
  if (code === 'picker_timeout') return 504
  if (code === 'picker_unavailable') return 503
  return 500
}
