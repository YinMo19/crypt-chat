/**
 * Compatibility re-export. The room hook used to live in this file; it
 * was split into `room/` to separate the MLS state machine
 * (`room/session.ts`) from the React glue (`room/useRoom.ts`). Existing
 * imports of `../lib/room` keep working unchanged.
 */
export { useRoom } from './room/index';
export type { ChatLine, RoomState, PeerEntry } from './room/types';
