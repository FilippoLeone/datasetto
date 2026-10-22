/**
 * bellwick versions, owned by the bellwick package (docs/arcade/plan.md §2.2). Bump `codec` when the wire
 * format changes (online play then needs the new client) and `sim` when the rules change (golden replays).
 */
export const VERSION = { codec: 1, sim: 1 } as const;
