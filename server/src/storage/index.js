import { appConfig } from '../config/index.js';
import MemoryMessageStore from './MemoryMessageStore.js';
import FileMessageStore from './FileMessageStore.js';

const DRIVER_MEMORY = 'memory';
const DRIVER_FILE = 'file';

function createMessageStore() {
  const driver = (appConfig.storage?.driver || DRIVER_MEMORY).toLowerCase();

  if (driver === DRIVER_FILE) {
    return new FileMessageStore({
      filePath: appConfig.storage.messageStorePath,
      debounceMs: appConfig.storage.flushDebounceMs,
    });
  }

  if (driver !== DRIVER_MEMORY) {
    console.warn(`Unknown storage driver "${driver}". Falling back to in-memory store.`);
  }

  return new MemoryMessageStore();
}

export const messageStore = createMessageStore();
export const storageDrivers = {
  memory: DRIVER_MEMORY,
  file: DRIVER_FILE,
};

export default {
  messageStore,
  drivers: storageDrivers,
};
