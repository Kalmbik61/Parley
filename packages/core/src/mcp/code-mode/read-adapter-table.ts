// The decoder of each decoded read method (T11 B0): one line per method. A T11 read adds its line here, its name to `MIGRATABLE_READS`
// (migration-registry.ts), and its output schema and adapter file to read-output-schemas.ts; a test keeps the three key sets equal.
//
// The schema and the adapter revision stay in read-output-schemas.ts, which imports nothing at run time: catalog.ts needs them, and
// this table imports the decoders, whose module loads validation.ts, which loads catalog.ts. Only the broker loads this table.

import { type Decoded, decodeBacklogList, decodeGetMap, decodeListRoles, decodeReadGuide, decodeReadRoom } from './read-adapters.js';
import { decodeMemoryRead } from './read-adapters/memory-read.js';
import { decodeSearchHistory } from './read-adapters/search-history.js';
import { decodeAttemptStatus } from './read-adapters/attempt-status.js';
import { decodePlanTasks } from './read-adapters/plan-tasks.js';

export type ReadDecoder = (args: unknown, mcpResult: unknown) => Decoded<unknown>;

export const READ_DECODERS: Readonly<Record<string, ReadDecoder>> = Object.freeze({
  attempt_status: decodeAttemptStatus,
  backlog_list: decodeBacklogList,
  get_map: decodeGetMap,
  list_roles: decodeListRoles,
  memory_read: decodeMemoryRead,
  plan_tasks: decodePlanTasks,
  read_guide: decodeReadGuide,
  read_room: decodeReadRoom,
  search_history: decodeSearchHistory,
});
