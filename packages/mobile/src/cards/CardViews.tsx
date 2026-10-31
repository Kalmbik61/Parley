import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { FeedCard, FeedPermissionCard, FeedPlanCard, FeedQuestionCard } from '@parley/core';
import { cardGist } from '@parley/core/card-gist';
import type { SessionRef } from '@parley/remote-client';
import { haptic } from '../haptics';
import { Markdown } from '../markdown/Markdown';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { alwaysRules, canAlways, EMPTY_QUESTION_DRAFT, gistView, questionDecision, toggleOther, togglePick, type QuestionDraft } from './model';
import { useDecision } from './use-decision';

const cardBox = (c: ReturnType<typeof useColors>) => ({ backgroundColor: c.surface, borderRadius: spacing.cardRadius, padding: 16, gap: 12 });

function Note({ text }: { text: string | null }) {
  const c = useColors();
  if (text === null) return null;
  return (
    <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
      {text}
    </Text>
  );
}

const PAUSED = 'Reconnecting — actions are paused';

/** Full tool input, monospaced, scrolls sideways (D1 §9.1). */
export function ToolInput({ text }: { text: string }) {
  const c = useColors();
  return (
    <ScrollView horizontal style={[styles.mono, { backgroundColor: c.surface2 }]}>
      <Text selectable allowFontScaling style={[typography.footnote, { fontFamily: 'Menlo', color: c.label }]}>
        {text}
      </Text>
    </ScrollView>
  );
}

function inputText(card: FeedPermissionCard): string {
  const input = card.toolInput;
  const command = input.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.join(' ');
  return JSON.stringify(input, null, 2);
}

/** The card split in two: `body` scrolls with the screen, `actions` go to the bottom panel (D1 §9). */
export interface CardParts {
  body: ReactNode;
  actions: ReactNode;
}

export interface CardProps<C> {
  card: C;
  sessionRef: SessionRef;
  projectPath: string;
  canAct: boolean;
  children: (parts: CardParts) => ReactNode;
}

/** Permission card with Deny / Allow and, only when the CLI suggested a rule, "Allow and don't ask again". */
export function PermissionCardView({ card, sessionRef, projectPath, canAct, children }: CardProps<FeedPermissionCard>) {
  const c = useColors();
  const d = useDecision(sessionRef, card.cardId);
  const view = gistView(cardGist(card, projectPath));
  const rules = alwaysRules(card.suggestions);
  const off = !canAct || d.busy;
  const body = (
    <View style={cardBox(c)}>
      <View style={styles.head}>
        <SymbolView name={view.icon} size={22} tintColor={c.tint} />
        <Text accessibilityRole="header" allowFontScaling style={[typography.headline, { color: c.label }]}>
          {view.title}
        </Text>
      </View>
      <ToolInput text={inputText(card)} />
      {card.truncated === true && (
        <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
          The input is long and was shortened.
        </Text>
      )}
    </View>
  );
  const actions = (
    <View style={{ gap: 12 }}>
      {canAlways(card) && (
        <View style={{ gap: 4 }}>
          <Button
            title="Allow and don't ask again"
            icon="faceid"
            hint="Requires Face ID"
            disabled={off}
            onPress={() => void d.submit({ kind: 'permission', behavior: 'allow', always: true })}
          />
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            Adds the rule: {rules?.join(', ')}
          </Text>
        </View>
      )}
      <View style={styles.pair}>
        <Button title="Deny" flex disabled={off} onPress={() => void d.submit({ kind: 'permission', behavior: 'deny' })} />
        <Button title="Allow" variant="prominent" icon="faceid" hint="Requires Face ID" flex loading={d.busy} disabled={!canAct} onPress={() => void d.submit({ kind: 'permission', behavior: 'allow' })} />
      </View>
      <Note text={!canAct ? PAUSED : d.message} />
    </View>
  );
  return <>{children({ body, actions })}</>;
}

export function QuestionCardView({ card, sessionRef, canAct, children }: CardProps<FeedQuestionCard>) {
  const c = useColors();
  const d = useDecision(sessionRef, card.cardId);
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_QUESTION_DRAFT);
  const decision = questionDecision(card, draft);
  const off = !canAct || d.busy;
  const body = (
    <View style={{ gap: 16 }}>
      {card.questions.map((q, at) => {
        const picked = draft.picked[at] ?? [];
        const otherOn = draft.otherOn[at] === true;
        return (
          <View key={at} style={cardBox(c)}>
            {q.header !== null && (
              <View style={[styles.capsule, { backgroundColor: c.neutralBg }]}>
                <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
                  {q.header}
                </Text>
              </View>
            )}
            <Text allowFontScaling style={[typography.body, { color: c.label }]}>
              {q.question}
            </Text>
            {q.options.map((o) => {
              const on = picked.includes(o.label);
              return (
                <Pressable
                  key={o.label}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: on, disabled: off }}
                  disabled={off}
                  onPress={() => { haptic.selection(); setDraft((x) => togglePick(x, at, q, o.label)); }}
                  style={styles.option}
                >
                  <View style={{ flex: 1 }}>
                    <Text allowFontScaling style={[typography.body, { color: c.label }]}>
                      {o.label}
                    </Text>
                    {o.description !== null && (
                      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
                        {o.description}
                      </Text>
                    )}
                  </View>
                  <SymbolView name={q.multiSelect ? (on ? 'checkmark.circle.fill' : 'circle') : 'checkmark'} size={20} tintColor={on ? c.tint : q.multiSelect ? c.label3 : 'transparent'} />
                </Pressable>
              );
            })}
            <Pressable accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: otherOn }} disabled={off} onPress={() => { haptic.selection(); setDraft((x) => toggleOther(x, at, q)); }} style={styles.option}>
              <Text allowFontScaling style={[typography.body, { color: c.label, flex: 1 }]}>
                Other
              </Text>
              <SymbolView name={q.multiSelect ? (otherOn ? 'checkmark.circle.fill' : 'circle') : 'checkmark'} size={20} tintColor={otherOn ? c.tint : q.multiSelect ? c.label3 : 'transparent'} />
            </Pressable>
            {otherOn && (
              <TextInput
                accessibilityLabel="Your answer"
                value={draft.otherText[at] ?? ''}
                onChangeText={(t) => setDraft((x) => ({ ...x, otherText: { ...x.otherText, [at]: t } }))}
                editable={!off}
                multiline
                style={[typography.body, styles.input, { color: c.label, backgroundColor: c.surface2 }]}
              />
            )}
          </View>
        );
      })}
    </View>
  );
  const actions = (
    <View style={{ gap: 8 }}>
      <Button title="Send answer" variant="prominent" loading={d.busy} disabled={!canAct || decision === null} onPress={() => decision !== null && void d.submit(decision)} />
      <Note text={!canAct ? PAUSED : d.message} />
    </View>
  );
  return <>{children({ body, actions })}</>;
}

export function PlanCardView({ card, sessionRef, canAct, children }: CardProps<FeedPlanCard>) {
  const c = useColors();
  const d = useDecision(sessionRef, card.cardId);
  const off = !canAct || d.busy;
  const body = (
    <View style={cardBox(c)}>
      <Markdown text={card.plan} />
    </View>
  );
  const actions = (
    <View style={{ gap: 12 }}>
      <Button title="Approve, auto-accept edits" variant="prominent" icon="faceid" hint="Requires Face ID" loading={d.busy} disabled={!canAct} onPress={() => void d.submit({ kind: 'plan', choice: 'auto-accept' })} />
      <Button title="Approve, approve each edit" icon="faceid" hint="Requires Face ID" disabled={off} onPress={() => void d.submit({ kind: 'plan', choice: 'manual' })} />
      <Text allowFontScaling style={[typography.footnote, { color: c.label2, textAlign: 'center' }]}>
        To keep planning, answer at your Mac
      </Text>
      <Note text={!canAct ? PAUSED : d.message} />
    </View>
  );
  return <>{children({ body, actions })}</>;
}

/** Picks the view for a card's kind. */
export function ActiveCard(props: Omit<CardProps<FeedCard>, 'card'> & { card: FeedCard }) {
  const { card, ...rest } = props;
  if (card.kind === 'permission') return <PermissionCardView {...rest} card={card} />;
  if (card.kind === 'question') return <QuestionCardView {...rest} card={card} />;
  return <PlanCardView {...rest} card={card} />;
}

/** Information-only card: nothing the phone can answer (Codex without an event, a limit, a sign-in). */
export function InfoCard({ icon, title, text, detail }: { icon: 'desktopcomputer' | 'hourglass' | 'person.badge.key'; title: string; text: string; detail?: string | null }) {
  const c = useColors();
  return (
    <View style={cardBox(c)}>
      <View style={styles.head}>
        <SymbolView name={icon} size={22} tintColor={c.tint} />
        <Text accessibilityRole="header" allowFontScaling style={[typography.headline, { color: c.label }]}>
          {title}
        </Text>
      </View>
      {detail != null && (
        <Text allowFontScaling style={[typography.subheadline, { color: c.label }]}>
          {detail}
        </Text>
      )}
      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pair: { flexDirection: 'row', gap: 12 },
  mono: { borderRadius: 10, padding: 10, maxHeight: 240 },
  capsule: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  input: { borderRadius: 10, padding: 10, minHeight: 44 },
});
