/**
 * Application entry point
 */
import '@/styles/main.css';
import { App } from './App';

// Initialize application
const app = new App();

// Expose to window for debugging (always available for mobile debugging)
declare global {
  interface Window {
    datasettoApp?: App;
  }
}
window.datasettoApp = app;

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  app.cleanup();
});
