// Голосовой экран (вкладка Voice, VO-01): рой душ, подпись, старт/стоп и mute, шаблон R15 с полем текста, ход работы, карточки.
// Экран всегда тёмный (палитра A), от темы системы не зависит.
import { useEffect, useMemo, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { typography, voicePalette } from '../theme';
import { CardSheet } from './CardSheet';
import { SwarmFace } from './face/SwarmFace';
import { phoneSwarmSpec } from './face/phone-spec';
import { useLiveVoice } from './use-live-voice';
import { composerSpacing } from './screen-model';
import { CONNECTING_CAPTION_DELAY_MS } from './voice-model';

/** Подпись «connecting» скрыта первые 150 мс, чтобы быстрое подключение не мигало. */
function useCaption(caption: string | null): string | null {
  const [late, setLate] = useState(false);
  const connecting = caption === 'connecting';
  useEffect(() => {
    setLate(false);
    if (!connecting) return undefined;
    const t = setTimeout(() => setLate(true), CONNECTING_CAPTION_DELAY_MS);
    return () => clearTimeout(t);
  }, [connecting]);
  return connecting && !late ? null : caption;
}

/** Высота открытой клавиатуры; 0, пока она закрыта. Экран вкладки тянется до низа окна, так что это ровно нужный отступ. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

export function VoiceScreen() {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const spacing = composerSpacing(insets.bottom, keyboardHeight);
  const v = useLiveVoice();
  const caption = useCaption(v.orb.caption);
  const { live, link } = v.swarm;
  const swarmSpec = useMemo(
    () => phoneSwarmSpec({ link, live }),
    // `live` пересоздаётся при каждом снимке; облик зависит только от этих полей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [link, live.phase, live.humanSpeaking, live.modelPlaying, live.checking, live.emotion],
  );
  const [text, setText] = useState('');
  const active = v.voice.state !== 'idle' && v.voice.state !== 'error' && v.voice.state !== 'offline' && v.voice.state !== 'limit_reached';
  const inSession = active && v.voice.state !== 'connecting';
  const canSend = text.trim() !== '' && !v.sending && v.fallback?.reason !== 'mac_unreachable';
  const send = (): void => {
    if (!canSend) return;
    void v.submitText(text).then((ok) => ok && setText(''));
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top, paddingBottom: spacing.pageBottom }]}>
      <ConnectionBanner />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, styles.title]}>
          Parley
        </Text>
        <View style={styles.orb} accessibilityLabel={caption ?? 'Parley voice'}>
          <SwarmFace spec={swarmSpec} level={v.swarm.level} active={live.phase !== 'idle'} />
        </View>
        {caption !== null && (
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.caption]}>
            {caption}
          </Text>
        )}

        {v.fallback !== null ? (
          <View style={styles.fallback} accessibilityRole="alert">
            <Text allowFontScaling style={[typography.headline, { color: voicePalette.text, textAlign: 'center' }]}>
              {v.fallback.title}
            </Text>
            <Text allowFontScaling style={[typography.subheadline, { color: voicePalette.text2, textAlign: 'center' }]}>
              {v.fallback.body}
            </Text>
            {v.fallback.retry && (
              <Pressable accessibilityRole="button" onPress={v.retry} style={styles.retry}>
                <Text allowFontScaling style={[typography.button, { color: voicePalette.accent }]}>
                  Try again
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            {v.errorText !== null && (
              <Text allowFontScaling style={[typography.subheadline, { color: voicePalette.error, textAlign: 'center' }]}>
                {v.errorText}
              </Text>
            )}
            <View style={styles.controls}>
              <RoundButton
                label={inSession || v.voice.state === 'connecting' ? 'Stop' : 'Start'}
                icon={active ? 'stop.fill' : 'mic.fill'}
                primary
                onPress={active ? v.stop : v.start}
              />
              <RoundButton label={v.muted ? 'Unmute' : 'Mute'} icon={v.muted ? 'mic.slash.fill' : 'mic'} disabled={!inSession} onPress={v.toggleMute} />
            </View>
          </>
        )}

        {v.progress !== null && (
          <Text accessibilityLabel={`Progress: ${v.progress}`} allowFontScaling style={[typography.footnote, styles.progress]}>
            {v.progress}
          </Text>
        )}
        {v.result !== null && (
          <View style={styles.result}>
            <Text allowFontScaling selectable style={[typography.body, { color: voicePalette.text }]}>
              {v.result}
            </Text>
          </View>
        )}
        {v.waitingText !== null && (
          <Pressable accessibilityRole="button" accessibilityLabel={v.waitingText} onPress={v.reopenCard} style={styles.waiting}>
            <Text allowFontScaling style={[typography.footnote, { color: voicePalette.accent }]}>
              {v.waitingText}
            </Text>
          </Pressable>
        )}
        {v.notice !== null && (
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.footnote, { color: voicePalette.error, textAlign: 'center' }]}>
            {v.notice}
          </Text>
        )}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: spacing.composerBottom }]}>
        <TextInput
          accessibilityLabel="Write your request"
          allowFontScaling
          editable={v.fallback?.reason !== 'mac_unreachable'}
          multiline
          onChangeText={setText}
          placeholder="Write your request"
          placeholderTextColor={voicePalette.text3}
          style={[typography.body, styles.input]}
          value={text}
        />
        <Pressable
          accessibilityLabel="Send request"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={[styles.sendButton, { opacity: canSend ? 1 : 0.4 }]}
        >
          <SymbolView name="arrow.up" size={18} tintColor={voicePalette.onAccent} />
        </Pressable>
      </View>
      <CardSheet card={v.card} visible={v.sheetOpen} mode={v.sheetMode} busy={v.cardBusy} onDecide={v.decide} onLater={v.later} />
    </View>
  );
}

function RoundButton({ label, icon, primary, disabled, onPress }: { label: string; icon: 'stop.fill' | 'mic.fill' | 'mic.slash.fill' | 'mic'; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.round, { backgroundColor: primary === true ? voicePalette.accent : voicePalette.raised, opacity: disabled === true ? 0.4 : 1 }]}
    >
      <SymbolView name={icon} size={26} tintColor={primary === true ? voicePalette.onAccent : voicePalette.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: voicePalette.bg },
  content: { alignItems: 'center', gap: 16, paddingHorizontal: 24, paddingBottom: 24 },
  title: { color: voicePalette.text, alignSelf: 'flex-start', paddingTop: 8 },
  orb: { marginTop: 24, width: 220, height: 220 },
  caption: { color: voicePalette.text2, textAlign: 'center' },
  controls: { flexDirection: 'row', gap: 24, marginTop: 8 },
  round: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  fallback: { gap: 6, padding: 16, borderRadius: 16, backgroundColor: voicePalette.surface, alignSelf: 'stretch' },
  retry: { alignSelf: 'center', minHeight: 44, justifyContent: 'center' },
  waiting: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, backgroundColor: voicePalette.surface },
  progress: { color: voicePalette.text3, textAlign: 'center' },
  result: { padding: 14, borderRadius: 14, backgroundColor: voicePalette.surface, alignSelf: 'stretch' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 8, backgroundColor: voicePalette.bg2 },
  input: { flex: 1, maxHeight: 120, minHeight: 44, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, color: voicePalette.text, backgroundColor: voicePalette.field },
  sendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: voicePalette.accent },
});
