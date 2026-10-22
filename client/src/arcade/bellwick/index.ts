/**
 * Bellwick's lazy chunk (plan.md §2.6.6: the default export is a GameChunk). Handover stub from the
 * platform: it mounts a "coming soon" card until the Bellwick package replaces it (owned by that
 * package from arcade-p-m1).
 */
import { comingSoon } from '../runtime/comingSoon';
import type { GameChunk } from '../runtime/types';

const chunk: GameChunk = comingSoon("Bellwick");
export default chunk;
