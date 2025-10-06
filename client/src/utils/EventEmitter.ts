/**
 * Simple event emitter for state management and component communication
 */
export class EventEmitter<T extends Record<string, unknown> = Record<string, unknown>> {
  private listeners: Map<keyof T, Set<(data: unknown) => void>> = new Map();

  /**
   * Subscribe to an event
   */
  on<K extends keyof T>(event: K, callback: (data: T[K]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    
    this.listeners.get(event)!.add(callback as (data: unknown) => void);
    
    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event once
   */
  once<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
    const unsubscribe = this.on(event, (data) => {
      callback(data);
      unsubscribe();
    });
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(callback as (data: unknown) => void);
    }
  }

  /**
   * Emit an event
   */
  emit<K extends keyof T>(event: K, data: T[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for "${String(event)}":`, error);
        }
      });
    }
  }

  /**
   * Clear all listeners
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Clear listeners for a specific event
   */
  clearEvent<K extends keyof T>(event: K): void {
    this.listeners.delete(event);
  }
}
