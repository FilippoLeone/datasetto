/**
 * Performance monitoring utilities
 * Helps identify bottlenecks and track key metrics
 */

interface PerformanceEntry {
  name: string;
  startTime: number;
  duration: number;
  metadata?: Record<string, unknown>;
}

interface PerformanceReport {
  pageLoadTime?: number;
  timeToInteractive?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
  customMeasurements: PerformanceEntry[];
  memoryUsage?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

class PerformanceMonitor {
  private measurements: PerformanceEntry[] = [];
  private marks: Map<string, number> = new Map();
  private enabled: boolean;
  private maxMeasurements = 100;

  constructor() {
    // Enable in dev mode or if explicitly enabled via localStorage
    this.enabled = import.meta.env.DEV || localStorage.getItem('datasetto.perfMonitor') === 'true';

    if (this.enabled && typeof window !== 'undefined') {
      this.observeWebVitals();
    }
  }

  /**
   * Start timing an operation
   */
  mark(name: string): void {
    if (!this.enabled) return;
    this.marks.set(name, performance.now());
  }

  /**
   * End timing and record the measurement
   */
  measure(name: string, metadata?: Record<string, unknown>): number | null {
    if (!this.enabled) return null;

    const startTime = this.marks.get(name);
    if (startTime === undefined) {
      console.warn(`[PerfMonitor] No mark found for: ${name}`);
      return null;
    }

    const duration = performance.now() - startTime;
    this.marks.delete(name);

    this.addMeasurement({
      name,
      startTime,
      duration,
      metadata,
    });

    return duration;
  }

  /**
   * Time an async operation
   */
  async timeAsync<T>(name: string, operation: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
    if (!this.enabled) {
      return operation();
    }

    this.mark(name);
    try {
      const result = await operation();
      this.measure(name, { ...metadata, success: true });
      return result;
    } catch (error) {
      this.measure(name, { ...metadata, success: false, error: String(error) });
      throw error;
    }
  }

  /**
   * Time a synchronous operation
   */
  time<T>(name: string, operation: () => T, metadata?: Record<string, unknown>): T {
    if (!this.enabled) {
      return operation();
    }

    this.mark(name);
    try {
      const result = operation();
      this.measure(name, { ...metadata, success: true });
      return result;
    } catch (error) {
      this.measure(name, { ...metadata, success: false, error: String(error) });
      throw error;
    }
  }

  /**
   * Add a measurement entry
   */
  private addMeasurement(entry: PerformanceEntry): void {
    this.measurements.push(entry);
    
    // Keep only recent measurements
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift();
    }
  }

  /**
   * Observe Core Web Vitals
   */
  private observeWebVitals(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      // Largest Contentful Paint
      const lcpObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          this.addMeasurement({
            name: 'LCP',
            startTime: 0,
            duration: lastEntry.startTime,
            metadata: { type: 'web-vital' },
          });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

      // First Input Delay
      const fidObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        entries.forEach((entry) => {
          const fidEntry = entry as unknown as PerformanceEventTiming;
          if (fidEntry.processingStart) {
            this.addMeasurement({
              name: 'FID',
              startTime: fidEntry.startTime,
              duration: fidEntry.processingStart - fidEntry.startTime,
              metadata: { type: 'web-vital' },
            });
          }
        });
      });
      fidObserver.observe({ type: 'first-input', buffered: true });

      // Cumulative Layout Shift
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          const layoutShift = entry as unknown as LayoutShift;
          if (!layoutShift.hadRecentInput) {
            clsValue += layoutShift.value;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });

      // Record CLS on page hide
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.addMeasurement({
            name: 'CLS',
            startTime: 0,
            duration: clsValue * 1000, // Scale for readability
            metadata: { type: 'web-vital', rawValue: clsValue },
          });
        }
      });
    } catch (error) {
      // PerformanceObserver not supported for these entry types
      if (import.meta.env.DEV) {
        console.warn('[PerfMonitor] Web Vitals observation not fully supported:', error);
      }
    }
  }

  /**
   * Get a performance report
   */
  getReport(): PerformanceReport {
    const report: PerformanceReport = {
      customMeasurements: [...this.measurements],
    };

    // Navigation timing
    if (typeof performance !== 'undefined' && performance.timing) {
      const timing = performance.timing;
      report.pageLoadTime = timing.loadEventEnd - timing.navigationStart;
      report.timeToInteractive = timing.domInteractive - timing.navigationStart;
    }

    // Paint timings
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      const paintEntries = performance.getEntriesByType('paint');
      const fcp = paintEntries.find(e => e.name === 'first-contentful-paint');
      if (fcp) {
        report.firstContentfulPaint = fcp.startTime;
      }
    }

    // Memory usage (Chrome only)
    if (typeof performance !== 'undefined') {
      const perfWithMemory = performance as Performance & {
        memory?: {
          usedJSHeapSize: number;
          totalJSHeapSize: number;
          jsHeapSizeLimit: number;
        };
      };
      if (perfWithMemory.memory) {
        report.memoryUsage = {
          usedJSHeapSize: perfWithMemory.memory.usedJSHeapSize,
          totalJSHeapSize: perfWithMemory.memory.totalJSHeapSize,
          jsHeapSizeLimit: perfWithMemory.memory.jsHeapSizeLimit,
        };
      }
    }

    return report;
  }

  /**
   * Get average duration for a specific measurement
   */
  getAverageDuration(name: string): number | null {
    const matching = this.measurements.filter(m => m.name === name);
    if (matching.length === 0) return null;
    
    const total = matching.reduce((sum, m) => sum + m.duration, 0);
    return total / matching.length;
  }

  /**
   * Clear all measurements
   */
  clear(): void {
    this.measurements = [];
    this.marks.clear();
  }

  /**
   * Enable/disable monitoring
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    try {
      if (enabled) {
        localStorage.setItem('datasetto.perfMonitor', 'true');
      } else {
        localStorage.removeItem('datasetto.perfMonitor');
      }
    } catch {
      // localStorage not available
    }
  }
}

// Types for Web Vitals
interface PerformanceEventTiming extends PerformanceEntry {
  processingStart: number;
}

interface LayoutShift extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

/**
 * Global performance monitor instance
 */
export const perfMonitor = new PerformanceMonitor();

/**
 * Expose debugging helpers on window in development
 */
if (typeof window !== 'undefined') {
  (window as typeof window & { __datasettoPerf?: typeof perfMonitor }).__datasettoPerf = perfMonitor;
}
