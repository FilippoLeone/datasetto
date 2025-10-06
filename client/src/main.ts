/**
 * Application entry point
 */
import '@/styles/main.css';
import { App } from './App';

// Initialize application
const app = new App();

// Expose to window for debugging (development only)
if (import.meta.env.DEV) {
  (window as { app?: App })['app'] = app;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  app.cleanup();
});
