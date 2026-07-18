import type { ThreadId } from './domain.ts'

/**
 * Wake-up notifications only. Durable events always come from SessionStore;
 * listeners must replay by cursor after every notification.
 */
export class ConversationEventHub {
  private readonly listeners = new Map<ThreadId, Set<() => void>>()

  subscribe(threadId: ThreadId, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(threadId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(threadId)
    }
  }

  publish(threadId: ThreadId): void {
    for (const listener of this.listeners.get(threadId) ?? []) listener()
  }

  clear(): void {
    this.listeners.clear()
  }
}
