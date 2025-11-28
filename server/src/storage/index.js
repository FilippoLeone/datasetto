import { appConfig } from '../config/index.js';
import MemoryMessageStore from './MemoryMessageStore.js';
import FileMessageStore from './FileMessageStore.js';
import RedisMessageStore from './RedisMessageStore.js';
import logger from '../utils/logger.js';

const DRIVER_MEMORY = 'memory';
const DRIVER_FILE = 'file';
const DRIVER_REDIS = 'redis';

function createMessageStore() {
  const driver = (appConfig.storage?.driver || DRIVER_MEMORY).toLowerCase();

  if (driver === DRIVER_REDIS) {
    logger.info('[Storage] Using Redis message store');
    return new RedisMessageStore({
      maxHistoryPerChannel: appConfig.messages.maxHistoryPerChannel,
    });
  }

  if (driver === DRIVER_FILE) {
    logger.info('[Storage] Using file-based message store');
    return new FileMessageStore({
      filePath: appConfig.storage.messageStorePath,
      debounceMs: appConfig.storage.flushDebounceMs,
    });
  }

  if (driver !== DRIVER_MEMORY) {
    console.warn(`Unknown storage driver "${driver}". Falling back to in-memory store.`);
  }

  logger.info('[Storage] Using in-memory message store');
  return new MemoryMessageStore();
}

export const messageStore = createMessageStore();
export const storageDrivers = {
  memory: DRIVER_MEMORY,
  file: DRIVER_FILE,
  redis: DRIVER_REDIS,
};

export default {
  messageStore,
  drivers: storageDrivers,
};
