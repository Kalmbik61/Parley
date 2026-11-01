// D1 §6.2. Camera permission states, the frame, torch, "not a Parley code", and a dev-only paste field.
import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SymbolView } from 'expo-symbols';
import { PlainButton, PrimaryButton } from '../../components/ui';
import { haptic } from '../../haptics';
import { pairing } from '../../pairing/instance';
import { LINK_MESSAGES } from '../../pairing/session';
import { typography, useColors } from '../../theme';

export default function Scanner() {
  const colors = useColors();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const [pasted, setPasted] = useState('');
  const handled = useRef(false);

  const accept = (data: string): void => {
    if (handled.current) return;
    const check = pairing.fromScan(data);
    if (check === 'ok') {
      handled.current = true;
      haptic.qrRecognized();
      router.replace('/pair/flow');
    } else {
      setRejected(LINK_MESSAGES[check]);
      setTimeout(() => setRejected(null), check === 'private-relay' ? 6000 : 2500);
    }
  };

  const denied = permission !== null && !permission.granted && !permission.canAskAgain;
  const noCamera = denied || cameraError;

  if (permission === null) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  if (!permission.granted && permission.canAskAgain) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <SymbolView name="qrcode.viewfinder" size={64} tintColor={colors.tint} />
        <Text allowFontScaling style={[typography.body, { color: colors.label, textAlign: 'center' }]}>
          Parley uses the camera only to scan the pairing code on your Mac.
        </Text>
        <PrimaryButton title="Continue" onPress={() => void requestPermission()} />
        <PlainButton title="Cancel" onPress={() => router.back()} />
      </View>
    );
  }
  if (noCamera) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <SymbolView name="video.slash" size={64} tintColor={colors.label2} />
        <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label }]}>
          Camera access is off
        </Text>
        <PrimaryButton title="Open Settings" onPress={() => void Linking.openSettings()} />
        {__DEV__ && (
          <TextInput
            accessibilityLabel="Paste pairing link"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste link (dev build)"
            placeholderTextColor={colors.label3}
            value={pasted}
            onChangeText={setPasted}
            onSubmitEditing={() => accept(pasted)}
            style={[styles.paste, { color: colors.label, backgroundColor: colors.surface }]}
          />
        )}
        <PlainButton title="Cancel" onPress={() => router.back()} />
      </View>
    );
  }
  return (
    <View style={styles.camera}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => accept(data)}
        onMountError={() => setCameraError(true)}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.top}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.topButton}>
            <Text allowFontScaling style={[typography.body, { color: '#fff' }]}>
              Cancel
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Turn flashlight off' : 'Turn flashlight on'}
            onPress={() => setTorch((t) => !t)}
            style={styles.topButton}
          >
            <SymbolView name={torch ? 'flashlight.on.fill' : 'flashlight.off.fill'} size={22} tintColor="#fff" />
          </Pressable>
        </View>
        <View style={styles.frameWrap}>
          <View style={styles.frame} />
          <Text allowFontScaling style={[typography.subheadline, { color: '#fff', marginTop: 20 }]}>
            Point at the QR code on your Mac
          </Text>
        </View>
        {rejected !== null && (
          <View style={[styles.toast, { backgroundColor: colors.warningBg }]} accessibilityLiveRegion="polite">
            <Text allowFontScaling style={[typography.subheadline, { color: colors.label }]}>
              {rejected}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFill, paddingTop: 60, paddingBottom: 48 },
  top: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
  topButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 260, height: 260, borderRadius: 24, borderWidth: 3, borderColor: '#fff' },
  toast: { marginHorizontal: 24, padding: 12, borderRadius: 12, alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  paste: { alignSelf: 'stretch', padding: 12, borderRadius: 10, fontSize: 15 },
});
