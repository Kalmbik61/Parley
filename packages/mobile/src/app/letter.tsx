// Letter (D1 §10.2): one direct letter, read-only. The full text comes by `context.letter` when the list holds a cut one.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text } from 'react-native';
import { workKeyOf } from '@parley/remote-client';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Markdown } from '../markdown/Markdown';
import { parseWorkParam } from '../nav/refs';
import { openedLetters } from '../letters/opened';
import { timeLabel } from '../letters/letters-model';
import { useRemoteState } from '../hooks/use-remote';
import { runtime } from '../runtime/instance';
import { spacing, typography, useColors } from '../theme';
import { View } from 'react-native';

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default function LetterScreen() {
  const colors = useColors();
  const p = useLocalSearchParams<{ id: string; ref: string }>();
  const id = str(p.id);
  const { projectPath, workId } = parseWorkParam(str(p.ref)) ?? { projectPath: '', workId: '' };
  const remote = useRemoteState();
  const message = remote?.letters[workKeyOf(projectPath, workId)]?.[id];
  const work = remote?.snapshot?.works.find((w) => w.projectPath === projectPath && w.id === workId);
  const [full, setFull] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cut = message?.textBytes !== undefined;

  useEffect(() => {
    openedLetters.add(id);
  }, [id]);
  useEffect(() => {
    if (!cut) return;
    let live = true;
    runtime
      .call('context.letter', { projectPath: projectPath, workId: workId, id })
      .then((res) => live && setFull((res as { message?: { text?: string } } | null)?.message?.text ?? null))
      .catch(() => live && setFailed(true));
    return () => void (live = false);
  }, [cut, id, projectPath, workId]);

  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Letter', headerBackTitle: 'Letters' }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.body}>
        <ConnectionBanner />
        {message === undefined ? (
          <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>{remote?.snapshot ? 'This letter was deleted' : ''}</Text>
        ) : (
          <>
            <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label }]}>{message.from} → you</Text>
            <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>{work?.title ?? ''} · {timeLabel(message.at)} · Opened on this phone</Text>
            <View style={[styles.card, { backgroundColor: colors.surface }]}>
              <Markdown text={full ?? message.text} />
              {cut && full === null && !failed ? <ActivityIndicator /> : null}
              {failed ? <Text allowFontScaling style={[typography.footnote, { color: colors.danger }]}>Couldn't load the full letter</Text> : null}
            </View>
            <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>Reply at your Mac — replies from the phone come later.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: spacing.screenMargin, gap: 8 },
  card: { borderRadius: spacing.cardRadius, padding: 16, gap: 8 },
});
