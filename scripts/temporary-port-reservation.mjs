import { createServer } from 'node:net'

export async function reserveTemporaryPort(label = 'temporary port', maxAttempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await reserveOnce(label)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Could not reserve ${label} after ${maxAttempts} attempts`, { cause: lastError })
}

function reserveOnce(label) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error(`Could not resolve ${label}`)))
        return
      }
      let released = false
      resolve({
        port: address.port,
        release: () => new Promise((release, releaseReject) => {
          if (released) return release()
          released = true
          server.close((error) => error ? releaseReject(error) : release())
        }),
      })
    })
  })
}
