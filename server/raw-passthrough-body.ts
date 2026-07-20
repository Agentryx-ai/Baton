import type { RequestHandler } from 'express'

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024

/** Capture request bytes without interpreting Content-Encoding. */
export function createRawPassthroughBody(limitBytes = DEFAULT_LIMIT_BYTES): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.body = Buffer.alloc(0)
      next()
      return
    }
    const declared = Number(req.get('content-length'))
    if (Number.isFinite(declared) && declared > limitBytes) {
      res.status(413).json({ error: { type: 'baton_proxy_body_too_large' } })
      return
    }
    void (async () => {
      try {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += bytes.length
          if (total > limitBytes) {
            res.status(413).json({ error: { type: 'baton_proxy_body_too_large' } })
            return
          }
          chunks.push(bytes)
        }
        req.body = Buffer.concat(chunks, total)
        next()
      } catch (error) {
        next(error)
      }
    })()
  }
}
