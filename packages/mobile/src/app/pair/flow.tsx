// One screen renders every step after the code is known (D1 §6.3–6.6), driven by `PairingSession`. Routing cannot
// skip a step: the session ignores calls made from the wrong step.
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { SasCode, SasCountdown } from '../../components/SasCode';
import { PlainButton, PrimaryButton } from '../../components/ui';
import { defaultDeviceName, pairing } from '../../pairing/instance';
import { DEVICE_NAME_MAX } from '../../pairing/session';
import { usePairState } from '../../pairing/use-pairing';
import { requestPermission } from '../../notifications/permission';
import { runtime } from '../../runtime/instance';
import { spacing, typography, useColors } from '../../theme';

export default function PairFlow() {
  const state = usePairState();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const leave = (): void => {
    pairing.finish();
    router.replace('/');
  };
  const cancel = (): void => {
    pairing.cancel();
    router.back();
  };
  useEffect(() => {
    // Opened with nothing in progress (e.g. after Fast Refresh): back out.
    if (state.step === 'idle') router.replace('/pair/welcome');
  }, [state.step, router]);

  const page = (children: React.ReactNode, top?: React.ReactNode) => (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.page, { backgroundColor: colors.bg }]}>
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom + 16 }}>
        <View style={styles.topBar}>{top}</View>
        {children}
      </View>
    </KeyboardAvoidingView>
  );
  const cancelBar = (
    <Pressable accessibilityRole="button" onPress={cancel} style={styles.cancel}>
      <Text allowFontScaling style={[typography.body, { color: colors.tint }]}>
        Cancel
      </Text>
    </Pressable>
  );

  switch (state.step) {
    case 'idle':
      return null;
    case 'confirm-link':
      return page(
        <View style={styles.body}>
          <View style={styles.center}>
            <SymbolView name="exclamationmark.shield" size={64} tintColor={colors.tint} />
            <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label, textAlign: 'center' }]}>
              Pair with a Mac?
            </Text>
            <Text allowFontScaling style={[typography.body, { color: colors.label2, textAlign: 'center' }]}>
              Continue only if you just scanned the code on your Mac.
            </Text>
          </View>
          <PrimaryButton title="Continue" onPress={() => pairing.confirm()} />
          <PlainButton title="Cancel" onPress={cancel} />
        </View>,
      );
    case 'name':
      return page(<NameStep />, cancelBar);
    case 'connecting':
      return page(
        <View style={[styles.body, styles.center]}>
          <ActivityIndicator size="large" />
          <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>
            Connecting to your Mac…
          </Text>
        </View>,
        cancelBar,
      );
    case 'sas':
      return page(
        <View style={styles.body}>
          <View style={styles.center}>
            <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: colors.label }]}>
              Check your Mac
            </Text>
            <SasCode code={state.code} />
            <Text allowFontScaling style={[typography.body, { color: colors.label2, textAlign: 'center' }]}>
              Your Mac shows the same code. Click “Codes match — Allow” there.
            </Text>
          </View>
          <SasCountdown expiresAt={state.expiresAt} />
        </View>,
        cancelBar,
      );
    case 'paired':
      return page(
        <View style={styles.body}>
          <View style={styles.center}>
            <SymbolView
              name="checkmark.circle.fill"
              size={88}
              type="multicolor"
              animationSpec={{ effect: { type: 'bounce' } }}
              tintColor={colors.success}
            />
            <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label, textAlign: 'center' }]}>
              {`Paired with ${state.record.hostName || 'your Mac'}`}
            </Text>
          </View>
          <PrimaryButton title="Continue" onPress={() => pairing.toNotifications()} />
        </View>,
      );
    case 'notify':
      return page(<NotifyStep onDone={leave} />);
    case 'failed': {
      const f = state.failure;
      return page(
        <View style={styles.body}>
          <View style={styles.center}>
            <SymbolView name={f.icon} size={64} tintColor={colors.label2} />
            <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label, textAlign: 'center' }]}>
              {f.title}
            </Text>
            <Text allowFontScaling style={[typography.body, { color: colors.label2, textAlign: 'center' }]}>
              {f.body}
            </Text>
            {f.note !== null && (
              <Text allowFontScaling style={[typography.footnote, { color: colors.label2, textAlign: 'center' }]}>
                {f.note}
              </Text>
            )}
          </View>
          <PrimaryButton
            title={f.action}
            onPress={() => {
              // The offer is spent after any failure past the handshake, so both actions go back to scanning.
              pairing.cancel();
              router.replace('/pair/scan');
            }}
          />
          <PlainButton title="Cancel" onPress={cancel} />
        </View>,
      );
    }
  }
}

function NameStep() {
  const colors = useColors();
  const [name, setName] = useState(defaultDeviceName());
  const go = (): void => void pairing.start(name);
  return (
    <View style={styles.body}>
      <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: colors.label }]}>
        Name this phone
      </Text>
      <View style={[styles.field, { backgroundColor: colors.surface }]}>
        <TextInput
          accessibilityLabel="Name"
          autoFocus
          maxLength={DEVICE_NAME_MAX}
          value={name}
          onChangeText={setName}
          onSubmitEditing={go}
          returnKeyType="done"
          style={[typography.body, { color: colors.label }]}
        />
      </View>
      <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>
        Your Mac shows this name when it asks to allow this phone.
      </Text>
      <View style={{ flex: 1 }} />
      <PrimaryButton title="Continue" onPress={go} disabled={name.trim() === ''} />
    </View>
  );
}

function NotifyStep({ onDone }: { onDone: () => void }) {
  const colors = useColors();
  const turnOn = async (): Promise<void> => {
    const result = await requestPermission();
    await runtime.setNotificationsEnabled(result === 'granted');
    onDone();
  };
  return (
    <View style={styles.body}>
      <View style={styles.center}>
        <SymbolView name="bell.badge" size={64} type="multicolor" tintColor={colors.tint} />
        <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label, textAlign: 'center' }]}>
          Know when an agent needs you
        </Text>
        <Text allowFontScaling style={[typography.body, { color: colors.label2, textAlign: 'center' }]}>
          Parley sends a notification when a session waits for your answer. It shows only how many things are waiting — no names, no text.
        </Text>
      </View>
      <PrimaryButton title="Turn on notifications" onPress={() => void turnOn()} />
      <PlainButton title="Not now" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  topBar: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.screenMargin },
  cancel: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  body: { flex: 1, paddingHorizontal: spacing.screenMargin, paddingTop: 12, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  field: { borderRadius: spacing.cardRadius, paddingHorizontal: 16, paddingVertical: 14 },
});
