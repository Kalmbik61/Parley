// Карточка помощника поверх голосового экрана (R06): Send / Cancel. Решает только человек, нажатием.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PhoneCard } from '@parley/protocol/remote';
import { typography, voicePalette } from '../theme';
import type { CardChoice } from './cards-model';

export function CardSheet({ card, busy, onDecide }: { card: PhoneCard | null; busy: boolean; onDecide: (choice: CardChoice) => void }) {
  return (
    <Modal visible={card !== null} transparent animationType="slide" onRequestClose={() => undefined}>
      <View style={styles.backdrop}>
        {card !== null && (
          <View accessibilityViewIsModal style={styles.sheet}>
            <Text accessibilityRole="header" allowFontScaling style={[typography.headline, { color: voicePalette.text }]}>
              {card.title !== '' ? card.title : 'Confirm'}
            </Text>
            {card.dangerous && (
              <Text allowFontScaling style={[typography.footnote, { color: voicePalette.error }]}>
                This action cannot be undone. Face ID is required to send.
              </Text>
            )}
            <Text allowFontScaling selectable style={[typography.body, { color: voicePalette.text2 }]}>
              {card.text}
            </Text>
            <View style={styles.buttons}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => onDecide('cancel')}
                style={[styles.button, { backgroundColor: voicePalette.raised, opacity: busy ? 0.5 : 1 }]}
              >
                <Text allowFontScaling style={[typography.button, { color: voicePalette.text }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => onDecide('send')}
                style={[styles.button, { backgroundColor: voicePalette.accent, opacity: busy ? 0.5 : 1 }]}
              >
                <Text allowFontScaling style={[typography.button, { color: voicePalette.onAccent }]}>
                  Send
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: voicePalette.surface, padding: 20, paddingBottom: 36, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  buttons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  button: { flex: 1, minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
