import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { haptic } from '../haptics';
import { SymbolView } from 'expo-symbols';
import type { RemoteSession } from '@parley/protocol/remote';
import { attentionOfSession, type RemoteState, type RemoteSwarm, type WorkRow, type WorkView } from '@parley/remote-client';
import { capsuleOfSession, type Capsule } from '../cards/status';
import { spacing, typography, useColors } from '../theme';
import { CountPill, Dot, toneColor } from '../ui/parts';
import { ProviderAvatar } from '../ui/avatars';
import { computeGuides, contentLeft, indentFor, STUB, trunkX, type GuideSpec } from './guides';
import { useNow } from '../hooks/use-remote';
import { elapsed } from './summary';
import { headLook, teamLine, teamOpenByDefault, type Team } from './teams';

export interface TreeActions {
  openSession(sessionId: string): void;
  openDecision(roomId: string, proposalId: string): void;
  openRoom(roomId: string): void;
}

export interface TreeEnv {
  state: RemoteState;
  view: WorkView;
  /** Shared clock (`useNow`): the "N ago" details tick with it. */
  now: number;
  actions: TreeActions;
}

const refOf = (view: WorkView, id: string) => ({ projectPath: view.work.projectPath, workId: view.work.id, sessionId: id });
/** The one word source of the tree: a row, a team head, a room or swarm member (`capsuleOf`, as the window's `sessionWord`). */
export const capsuleIn = (env: TreeEnv, s: RemoteSession): Capsule => capsuleOfSession(env.state, refOf(env.view, s.id), s, env.now);

/** `Finished a turn · 3 min ago`: the word and its age (D1 §8.2). */
const wordLine = (cap: Capsule): string => (cap.detail === null ? cap.label : `${cap.label} · ${cap.detail}`);

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
  const cap = capsuleIn(env, session);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${session.label}. ${wordLine(cap)}`}
      onPress={() => env.actions.openSession(session.id)}
      style={[styles.line, { paddingLeft: depth === 0 || indent === undefined ? 12 : contentLeft(depth, indent) }]}
    >
      {spec !== undefined && indent !== undefined && <Guides spec={spec} indent={indent} mid={24} />}
      <ProviderAvatar provider={session.provider} size={24} badge={<Dot color={toneColor(c, cap.tone)} ring={cap.ring} />} />
      <View style={styles.flex}>
        <Text numberOfLines={1} allowFontScaling style={[typography.body, { color: session.lifecycle === 'closed' ? c.label2 : c.label }]}>
          {session.label}
        </Text>
        <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          {wordLine(cap)}
          {session.role !== null ? ` · ${session.role}` : ''}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={c.label3} />
    </Pressable>
  );
}

/** `spec` and `indent` are absent when the block is a team head (nothing above it to join): no trunk, a plain margin. */
function RoomBlock({ row, depth, env, spec, indent }: { row: Extract<WorkRow, { kind: 'room' }>; depth: number; env: TreeEnv; spec?: GuideSpec; indent?: number }) {
  const c = useColors();
  const p = row.room.proposal;
  const memberWaits = row.members.some((m) => attentionOf(env, m) === 'needs-you');
  const [open, setOpen] = useState(p !== null || memberWaits);
  const waits = memberWaits || p !== null;
  const stateWord = p !== null ? 'decision' : memberWaits ? 'needs you' : null;
  const leadLabel = row.members.find((m) => m.id === row.room.lead)?.label ?? null;
  return (
    <View>
      {spec !== undefined && indent !== undefined && <Guides spec={spec} indent={indent} mid={28} />}
      <View style={[styles.block, { marginLeft: indent === undefined ? 8 : contentLeft(depth, indent) - 2, backgroundColor: waits ? c.warningBg : c.surface2, borderColor: waits ? c.tint : 'transparent' }]}>
      <View style={styles.blockHead}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Room ${row.room.title}. ${stateWord ?? ''} ${row.room.mode ?? 'free'}, ${row.room.members.length} agents`} accessibilityHint="Opens the room chat" onPress={() => env.actions.openRoom(row.room.id)} style={[styles.flex, { gap: 4 }]}>
          <View style={styles.roomTitle}>
            <SymbolView name="number" size={15} tintColor={c.label2} />
            <Text numberOfLines={2} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label, fontWeight: waits ? '700' : '600' }]}>
              {row.room.title}
            </Text>
            {stateWord !== null && (
              <Text allowFontScaling style={[typography.caption1, { color: p !== null ? c.tint : c.needsYou, fontWeight: '600' }]}>
                {stateWord}
              </Text>
            )}
          </View>
          <View style={styles.roomTitle}>
            <View style={[styles.mode, { backgroundColor: c.surface, borderColor: c.separator }]}>
              <Text allowFontScaling style={[typography.caption2, { color: c.label2 }]}>
                {row.room.mode ?? 'free'}
              </Text>
            </View>
            <Text numberOfLines={1} allowFontScaling style={[typography.caption1, styles.flex, { color: c.label2 }]}>
              {row.room.members.length} agent{row.room.members.length === 1 ? '' : 's'}
              {leadLabel === null ? '' : ` · lead ${leadLabel}`}
            </Text>
          </View>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Collapse room' : 'Expand room'} accessibilityState={{ expanded: open }} onPress={() => { setOpen((o) => !o); haptic.selection(); }} style={styles.chevron}>
          <SymbolView name={open ? 'chevron.up' : 'chevron.down'} size={12} tintColor={c.label3} />
        </Pressable>
      </View>
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
          <MemberLine key={m.id} m={m} lead={row.room.lead === m.id} env={env} />
        ))}
      </View>
    </View>
  );
}

/** A room member: avatar with the state dot, name, the state word and its age (a dot is never the only carrier, D1 §1.4). */
function MemberLine({ m, lead, env }: { m: RemoteSession; lead: boolean; env: TreeEnv }) {
  const c = useColors();
  const cap = capsuleIn(env, m);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${m.label}. ${wordLine(cap)}${lead ? '. Lead' : ''}`} onPress={() => env.actions.openSession(m.id)} style={styles.memberLine}>
      <ProviderAvatar provider={m.provider} size={20} badge={<Dot color={toneColor(c, cap.tone)} ring={cap.ring} />} />
      <View style={styles.flex}>
        <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, { color: c.label }]}>
          {m.label}
        </Text>
        <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          {wordLine(cap)}
        </Text>
      </View>
      {lead && <SymbolView name="star.fill" size={12} tintColor={c.tint} />}
    </Pressable>
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

function SwarmBlock({ row, depth, env, spec, indent }: { row: Extract<WorkRow, { kind: 'swarm' }>; depth: number; env: TreeEnv; spec?: GuideSpec; indent?: number }) {
  const c = useColors();
  const waits = row.members.some((m) => m.session !== null && attentionOf(env, m.session) === 'needs-you');
  const [open, setOpen] = useState(waits);
  const workers = row.members.filter((m) => m.member.role !== 'queen');
  const handed = workers.filter((m) => m.member.handedAt !== null).length;
  const end = row.swarm.status === 'done' ? '✓' : row.swarm.status === 'failed' ? '⚠' : row.swarm.status === 'cancelled' ? '✕' : '';
  return (
    <View>
      {spec !== undefined && indent !== undefined && <Guides spec={spec} indent={indent} mid={28} />}
      <View style={[styles.block, { marginLeft: indent === undefined ? 8 : contentLeft(depth, indent) - 2, backgroundColor: c.surface2, borderColor: 'transparent' }]}>
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
                {m.member.handedAt !== null ? 'handed in ✓' : m.session === null ? 'closed' : capsuleIn(env, m.session).label}
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
  const look = headLook(team.head);
  // A room or a swarm nobody owns heads a team: it is drawn as its own container, not as a session card (A35a).
  if (look.kind !== 'session') return <ContainerHead team={team} env={env} />;
  return <SessionTeamCard team={team} env={env} />;
}

/** The head of a team is a room or a swarm: the same container as inside a tree, with whatever hangs under it below. */
function ContainerHead({ team, env }: { team: Team; env: TreeEnv }) {
  const c = useColors();
  const head = team.head;
  return (
    <View style={[styles.card, { backgroundColor: c.surface }]}>
      {head.kind === 'room' ? <RoomBlock row={head} depth={0} env={env} /> : head.kind === 'swarm' ? <SwarmBlock row={head} depth={0} env={env} /> : null}
      {team.children.length > 0 && <TreeRows rows={team.children} env={env} />}
    </View>
  );
}

function SessionTeamCard({ team, env }: { team: Team; env: TreeEnv }) {
  const c = useColors();
  const headSession = team.head.kind === 'session' ? team.head.session : null;
  const waits = [headSession, ...team.children.flatMap((x) => (x.row.kind === 'session' ? [x.row.session] : x.row.kind === 'room' ? x.row.members : []))].filter((s): s is RemoteSession => s !== null);
  const [open, setOpen] = useState(teamOpenByDefault(waits.map((s) => attentionOf(env, s))));
  const name = headSession?.label ?? (team.head.kind === 'room' ? team.head.room.title : team.head.kind === 'swarm' ? `Swarm [${team.head.swarm.tag}]` : '');
  // `TeamCard` draws this card only for a session head, so the word always comes from `capsuleOf`.
  const headCap = headSession !== null ? capsuleIn(env, headSession) : null;
  const headWord = headCap === null ? '' : wordLine(headCap);
  const toggle = (): void => { setOpen((o) => !o); haptic.selection(); };
  return (
    <View style={[styles.card, { backgroundColor: c.surface }]}>
      <View style={styles.teamHead}>
        {open && team.children.length > 0 && (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: trunkX(1, 28), top: 48, bottom: 0, width: LINE, backgroundColor: c.treeLine }} />
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={`${name}. ${headWord}`} onPress={() => headSession !== null && env.actions.openSession(headSession.id)} style={[styles.row, styles.flex, { alignItems: 'flex-start' }]}>
          {headSession !== null ? (
            <ProviderAvatar provider={headSession.provider} size={36} badge={headCap === null ? undefined : <Dot color={toneColor(c, headCap.tone)} ring={headCap.ring} />} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: c.tint }]}>
              <Text style={[typography.headline, { color: c.onTint }]}>{name.slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.flex}>
            <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
              {name}
            </Text>
            <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
              {headWord}
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
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 12, minHeight: 48 },
  roomTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mode: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 1 },
  decision: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 10, minHeight: 44 },
  memberLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, minHeight: 44 },
});
