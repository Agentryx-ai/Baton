/**
 * Worker-thread bootstrap: registers the tsx loader inside the worker before
 * importing the TypeScript entry. Worker threads do not reliably inherit the
 * parent's loader hooks (observed under `tsx --test`), so the worker must
 * install its own instead of assuming execArgv propagation.
 */
import { register } from 'tsx/esm/api'

register()
await import('./session-host-worker.ts')
