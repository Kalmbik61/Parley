import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { haptic } from '../haptics';
import { SymbolView } from 'expo-symbols';
import type { RemoteSession } from '@parley/protocol/remote';
import { attentionOfSession, sessionKey, type RemoteState, type RemoteSwarm, type WorkRow, type WorkView } from '@parley/remote-client';
import { capsuleOf } from '../cards/status';
import { spacing, typography, useColors } from '../theme';
import { attentionColor, attentionWord, CountPill, Dot } from '../ui/parts';
import { computeGuides, contentLeft, indentFor, STUB, trunkX, type GuideSpec } from './guides';
import { useNow } from '../hooks/use-remote';
import { elapsed } from './summary';
import { teamLine, teamOpenByDefault, type Team } from './teams';

export interface TreeActions {
  openSession(sessionId: string): void;
  openDecision(roomId: string, proposalId: string): void;
}

export interface TreeEnv {
  state: RemoteState;
  view: WorkView;
  actions: TreeActions;
}

const refOf = (view: WorkView, id: string) => ({ projectPath: view.work.projectPath, workId: view.work.id, sessionId: id });
export const attentionOf = (env: TreeEnv, s: RemoteSession) => attentionOfSession(env.state, refOf(env.view, s.id), s);

const LINE = 1.5;
const RADIUS = 10;

/**
 * Trunks of the ancestors, plus this row's own: from the top to the middle of the row with a rounded corner towards the
 * icon or the container edge; a tee (the trunk goes on) unless it is the last child. Hidden from VoiceOver (D1 §18).
 */
function Guides({ spec, indent, mid }: { spec: GuideSpec; indent: number; mid: number }) {
  const c = useColors();
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      {spec.continues.map((on, i) =>
        on ? <View key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: trunkX(i + 1, indent), width: LINE, backgroundColor: c.treeLine }} /> : null,
      )}
      <View
        style={{
          position: 'absolute',
          top: 0,
          height: mid,
          left: trunkX(spec.depth, indent),
          width: STUB,
          borderLeftWidth: LINE,
          borderBottomWidth: LINE,
          borderBottomLeftRadius: RADIUS,
          borderColor: c.treeLine,
        }}
      />
      {!spec.last && <View style={{ position: 'absolute', top: mid, bottom: 0, left: trunkX(spec.depth, indent), width: LINE, backgroundColor: c.treeLine }} />}
    </View>
  );
}

function SessionLine({ session, depth, env, spec, indent }: { session: RemoteSession; depth: number; env: TreeEnv; spec?: GuideSpec; indent?: number }) {
  const c = useColors();
  const a = attentionOf(env, session);
  const live = env.state.activity[sessionKey(refOf(env.view, session.id))];
  const cap = capsuleOf({ session, attention: a, need: live?.activity.need ?? session.stuck, subagents: live?.activity.subagents ?? 0, waitingFor: live?.activity.waitingFor ?? null, turnEndedAt: live?.activity.turnEndedAt ?? null, now: Date.now() });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${session.label}. ${attentionWord(a)}`}
      onPress={() => env.actions.openSession(session.id)}
      style={[styles.line, { paddingLeft: depth === 0 || indent === undefined ? 12 : contentLeft(depth, indent) }]}
    >
      {spec !== undefined && indent !== undefined && <Guides spec={spec} indent={indent} mid={24} />}
      <Dot color={attentionColor(c, a)} ring={a === 'unseen'} />
      <View style={styles.flex}>
        <Text numberOfLines={1} allowFontScaling style={[typography.body, { color: session.lifecycle === 'closed' ? c.label2 : c.label }]}>
          {session.label}
        </Text>
        <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          {cap.label}
          {session.role !== null ? ` · ${session.role}` : ''}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={c.label3} />
    </Pressable>
  );
}

function RoomBlock({ row, depth, env, spec, indent }: { row: Extract<WorkRow, { kind: 'room' }>; depth: number; env: TreeEnv; spec: GuideSpec; indent: number }) {
  const c = useColors();
  const p = row.room.proposal;
  const memberWaits = row.members.some((m) => attentionOf(env, m) === 'needs-you');
  const [open, setOpen] = useState(p !== null || memberWaits);
  return (
    <View>
      <Guides spec={spec} indent={indent} mid={28} />
      <View style={[styles.block, { marginLeft: contentLeft(depth, indent) - 2, backgroundColor: p !== null ? c.warningBg : c.surface2, borderColor: p !== null ? c.tint : 'transparent' }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen((o) => !o); haptic.selection(); }} style={styles.blockHead}>
        <SymbolView name={p !== null ? 'checkmark.seal' : 'number'} size={18} tintColor={c.tint} />
        <View style={styles.flex}>
          <Text numberOfLines={2} allowFontScaling style={[typography.headline, { color: c.label }]}>
            {row.room.title}
          </Text>
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            Room · {row.room.members.length} agent{row.room.members.length === 1 ? '' : 's'}
          </Text>
        </View>
        <SymbolView name={open ? 'chevron.up' : 'chevron.down'} size={12} tintColor={c.label3} />
      </Pressable>
      {p !== null && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Decision from ${p.from}. Review`} onPress={() => env.actions.openDecision(row.room.id, p.id)} style={styles.decision}>
          <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label }]}>
            {p.id} · rev {p.rev} · {p.text.split('\n')[0]}
          </Text>
          <Text allowFontScaling style={[typography.subheadline, { color: c.tint, fontWeight: '600' }]}>
            Review ›
          </Text>
        </Pressable>
      )}
      {open &&
        row.members.map((m) => (
          <Pressable key={m.id} accessibilityRole="button" onPress={() => env.actions.openSession(m.id)} style={styles.memberLine}>
            <Dot color={attentionColor(c, attentionOf(env, m))} ring={attentionOf(env, m) === 'unseen'} />
            <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label }]}>
              {m.label}
            </Text>
            {row.room.lead === m.id && <SymbolView name="star.fill" size={12} tintColor={c.tint} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function SwarmTimer({ swarm }: { swarm: RemoteSwarm }) {
  const c = useColors();
  const running = swarm.endedAt === null && (swarm.status === 'running' || swarm.status === 'collecting');
  const now = useNow(running ? 1000 : 3_600_000);
  return (
    <Text accessibilityElementsHidden allowFontScaling style={[typography.caption1, { color: c.label2, fontVariant: ['tabular-nums'] }]}>
      {elapsed(swarm.createdAt, swarm.endedAt, now)}
    </Text>
  );
}

const SWARM_WORD = { queen: 'Queen', drone: 'Drone', verifier: 'Verifier' } as const;

function SwarmBlock({ row, depth, env, spec, indent }: { row: Extract<WorkRow, { kind: 'swarm' }>; depth: number; env: TreeEnv; spec: GuideSpec; indent: number }) {
  const c = useColors();
  const waits = row.members.some((m) => m.session !== null && attentionOf(env, m.session) === 'needs-you');
  const [open, setOpen] = useState(waits);
  const workers = row.members.filter((m) => m.member.role !== 'queen');
  const handed = workers.filter((m) => m.member.handedAt !== null).length;
  const end = row.swarm.status === 'done' ? '✓' : row.swarm.status === 'failed' ? '⚠' : row.swarm.status === 'cancelled' ? '✕' : '';
  return (
    <View>
      <Guides spec={spec} indent={indent} mid={28} />
      <View style={[styles.block, { marginLeft: contentLeft(depth, indent) - 2, backgroundColor: c.surface2, borderColor: 'transparent' }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen((o) => !o); haptic.selection(); }} style={styles.blockHead}>
        <SymbolView name="hexagon.fill" size={20} tintColor={row.swarm.status === 'failed' || row.swarm.status === 'cancelled' ? c.off : c.tint} />
        <View style={styles.flex}>
          <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
            Swarm <Text style={{ color: c.label2, fontWeight: '400' }}>[{row.swarm.tag}]</Text>
          </Text>
          <View style={styles.dots}>
            {workers.map((m) => (
              <Dot key={m.member.sessionId} color={m.member.handedAt !== null ? c.success : c.idle} ring={m.member.handedAt === null} />
            ))}
            <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
              {workers.length > 0 ? `${handed}/${workers.length}` : '…'} {end}
            </Text>
            <SwarmTimer swarm={row.swarm} />
          </View>
        </View>
        <SymbolView name={open ? 'chevron.up' : 'chevron.down'} size={12} tintColor={c.label3} />
      </Pressable>
      {open && (
        <>
          {row.members.map((m) => (
            <Pressable key={m.member.sessionId} disabled={m.session === null} accessibilityRole="button" onPress={() => m.session && env.actions.openSession(m.session.id)} style={styles.memberLine}>
              <Text allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label }]}>
                {SWARM_WORD[m.member.role]}
                {m.member.role === 'drone' ? ` ${m.member.n}` : ''}
              </Text>
              <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
                {m.member.handedAt !== null ? 'handed in ✓' : m.session?.lifecycle === 'closed' ? 'closed' : 'working'}
              </Text>
            </Pressable>
          ))}
          {(row.swarm.status === 'done' || row.swarm.status === 'failed') && (
            <Text allowFontScaling style={[typography.footnote, { color: c.label2, padding: 12 }]}>
              The queen's summary is on your Mac
            </Text>
          )}
        </>
      )}
      </View>
    </View>
  );
}

/** Rows of a tree (descendants of one head), depth relative to it, joined by trunks and corners (D1 §8.2). */
export function TreeRows({ rows, env }: { rows: Array<{ row: WorkRow; depth: number }>; env: TreeEnv }) {
  const { fontScale } = useWindowDimensions();
  const indent = indentFor(fontScale);
  const guides = computeGuides(rows.map((r) => r.depth));
  return (
    <View>
      {rows.map(({ row, depth }, i) =>
        row.kind === 'session' ? (
          <SessionLine key={row.session.id} session={row.session} depth={depth} env={env} spec={guides[i]!} indent={indent} />
        ) : row.kind === 'room' ? (
          <RoomBlock key={row.room.id} row={row} depth={depth} env={env} spec={guides[i]!} indent={indent} />
        ) : (
          <SwarmBlock key={row.swarm.id} row={row} depth={depth} env={env} spec={guides[i]!} indent={indent} />
        ),
      )}
    </View>
  );
}

/** One team card: header (the main session) and everything under it. Single sessions are drawn by `SingleGroup`. */
export function TeamCard({ team, env }: { team: Team; env: TreeEnv }) {
  const c = useColors();
  const headSession = team.head.kind === 'session' ? team.head.session : null;
  const waits = [headSession, ...team.children.flatMap((x) => (x.row.kind === 'session' ? [x.row.session] : x.row.kind === 'room' ? x.row.members : []))].filter((s): s is RemoteSession => s !== null);
  const [open, setOpen] = useState(teamOpenByDefault(waits.map((s) => attentionOf(env, s))));
  const name = headSession?.label ?? (team.head.kind === 'room' ? team.head.room.title : team.head.kind === 'swarm' ? `Swarm [${team.head.swarm.tag}]` : '');
  const a = headSession !== null ? attentionOf(env, headSession) : 'idle';
  const toggle = (): void => { setOpen((o) => !o); haptic.selection(); };
  return (
    <View style={[styles.card, { backgroundColor: c.surface }]}>
      <View style={styles.teamHead}>
        {open && team.children.length > 0 && (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: trunkX(1, 28), top: 48, bottom: 0, width: LINE, backgroundColor: c.treeLine }} />
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={`${name}. ${attentionWord(a)}`} onPress={() => headSession !== null && env.actions.openSession(headSession.id)} style={[styles.row, styles.flex, { alignItems: 'flex-start' }]}>
          <View style={[styles.avatar, { backgroundColor: c.tint }]}>
            <Text style={[typography.headline, { color: c.onTint }]}>{name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.flex}>
            <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
              {name}
            </Text>
            <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
              {attentionWord(a)}
            </Text>
            {team.children.length > 0 && (
              <Text allowFontScaling style={[typography.footnote, { color: c.tint }]}>
                {teamLine(team.counts)}
              </Text>
            )}
          </View>
        </Pressable>
        <CountPill n={team.needsYou} />
        {team.children.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Collapse team' : 'Expand team'} accessibilityState={{ expanded: open }} onPress={toggle} style={styles.chevron}>
            <SymbolView name={open ? 'chevron.up' : 'chevron.down'} size={14} tintColor={c.label2} />
          </Pressable>
        )}
      </View>
      {open && team.children.length > 0 && <TreeRows rows={team.children} env={env} />}
      {open && team.more !== null && (
        <Pressable accessibilityRole="button" onPress={() => env.actions.openSession(team.more!.underSessionId)} style={styles.more}>
          <SymbolView name="arrow.turn.down.right" size={12} tintColor={c.tint} />
          <Text allowFontScaling style={[typography.subheadline, { color: c.tint }]}>
            {team.more.count} more under {team.more.underLabel} ›
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function SingleGroup({ teams, env }: { teams: Team[]; env: TreeEnv }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.surface }]}>
      {teams.map((t) => (t.head.kind === 'session' ? <SessionLine key={t.id} session={t.head.session} depth={0} env={env} /> : null))}
    </View>
  );
}


const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: { borderRadius: spacing.cardRadius, paddingVertical: 6, overflow: 'hidden' },
  teamHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  chevron: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingRight: 12 },
  block: { marginRight: 8, marginVertical: 4, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 48 },
  decision: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 10, minHeight: 44 },
  memberLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, minHeight: 44 },
});
