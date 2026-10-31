// Settings rows owned by A16 (D1 §11.6, §11.2): placed by the Settings screen (A14).
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { approve, faceIdSetting } from '../auth/instance';
import { toggleFaceId } from '../auth/face-id-setting';
import { useRuntimeState } from '../runtime/use-runtime';
import { typography, useColors } from '../theme';

export const PUSH_UNAVAILABLE = 'Notifications unavailable on this build';

/** "Require Face ID to allow": turning it off asks Face ID itself; turning it on is immediate. */
export function RequireFaceIdRow() {
  const colors = useColors();
  const [on, setOn] = useState(true);
  useEffect(() => {
    void faceIdSetting.get().then(setOn);
    return faceIdSetting.subscribe(setOn);
  }, []);
  return (
    <View style={styles.col}>
      <View style={styles.row}>
        <SymbolView name="faceid" tintColor={colors.tint} size={22} />
        <Text allowFontScaling style={[typography.body, { color: colors.label, flex: 1 }]}>Require Face ID to allow</Text>
        <Switch value={on} onValueChange={(next) => void toggleFaceId(faceIdSetting, approve, next).then(setOn)} />
      </View>
      <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>
        {on
          ? 'Parley asks for Face ID before Allow and Accept. Deny, Return for rework, answers and viewing never ask.'
          : 'Allow and Accept are sent without Face ID. Anyone holding this unlocked iPhone can approve.'}
      </Text>
    </View>
  );
}

/** Shown only when the last `push.register` went out without a token (Personal Team). */
export function PushUnavailableRow() {
  const colors = useColors();
  const { pushAvailability } = useRuntimeState();
  if (pushAvailability !== 'unavailable') return null;
  return (
    <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>{PUSH_UNAVAILABLE}</Text>
  );
}

const styles = StyleSheet.create({ col: { gap: 6 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
