import type { DotState, SessionLifecycle } from '@parley/core';

export type HumanOverviewGroup = 'needsHuman' | 'working' | 'other';
export interface HumanOverviewSource {
  kind: 'plan' | 'proposal' | 'card' | 'activity' | 'message';
  ref: string;
  at: string | null;
  rev?: number;
  item?: number;
}
export interface HumanOverviewFact {
  text: string;
  source: HumanOverviewSource;
}
export interface HumanOverviewWait extends HumanOverviewFact {
  needsHuman: boolean;
  actorRef: string | null;
}
export interface HumanOverviewMember {
  ref: string;
  displayName: string;
  role: string | null;
  lifecycle: SessionLifecycle | null;
  state: DotState | 'unknown';
  activityKnown: boolean;
  ambiguous: boolean;
}
export interface HumanOverviewSession extends HumanOverviewMember {
  group: HumanOverviewGroup;
  waits: HumanOverviewWait[];
}
export interface HumanOverviewRoom {
  ref: string;
  title: string;
  workLabel: string;
  group: HumanOverviewGroup;
  activityKnown: boolean;
  task: { text: string; source: HumanOverviewSource | null; goalKnown: boolean };
  currentSteps: HumanOverviewFact[];
  lead: HumanOverviewMember | null;
  members: HumanOverviewMember[];
  waits: HumanOverviewWait[];
  latestLeadNote?: HumanOverviewFact;
  warnings: string[];
}
/** A projection of permitted data, capturedAt does not promise an atomic snapshot. */
export interface HumanOverviewV1 {
  schemaVersion: 1;
  capturedAt: string;
  scope: { works: string[]; rooms: string[] };
  coverage: {
    mapComplete: boolean;
    activityAvailable: boolean;
    cardsAvailable: boolean;
    reasons: string[];
  };
  counts: Record<HumanOverviewGroup, number> & { activityUnknown: number };
  rooms: HumanOverviewRoom[];
  unassignedSessions: HumanOverviewSession[];
  text: string;
}
