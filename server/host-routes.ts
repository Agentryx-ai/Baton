import { Router } from 'express'

import {
  NativeFolderPickerError,
  pickNativeFolder,
} from './session/native-folder-picker.ts'

const INTERACTION_HEADER = 'x-baton-interaction'
const FOLDER_PICKER_INTERACTION = 'native-folder-picker'

export interface HostRouteOptions {
  pickFolder?: () => Promise<string | null>
}

export function createHostRouter(options: HostRouteOptions = {}): Router {
  const router = Router()
  const pickFolder = options.pickFolder ?? (() => pickNativeFolder())

  router.post('/baton/host/folders/pick', async (req, res) => {
    if (req.get(INTERACTION_HEADER) !== FOLDER_PICKER_INTERACTION) {
      res.status(403).json({ code: 'interaction_required', error: 'Explicit native folder interaction is required' })
      return
    }
    try {
      const cwd = await pickFolder()
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

function folderPickerStatus(code: NativeFolderPickerError['code']): number {
  if (code === 'unsupported_os' || code === 'invalid_picker_response') return 400
  if (code === 'picker_timeout') return 504
  if (code === 'picker_unavailable') return 503
  return 500
}
