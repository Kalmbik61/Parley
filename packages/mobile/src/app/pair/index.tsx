// Entry of `parley://pair?…` (opened from the system Camera or any web page): always the confirm screen (D1 §6.3).
import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { PlainButton } from '../../components/ui';
import { pairing } from '../../pairing/instance';
import { LINK_MESSAGES, linkFromParams } from '../../pairing/session';
import { typography, useColors } from '../../theme';

export default function PairLink() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const colors = useColors();
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const url = linkFromParams(params);
    if (url === null) return setMessage(LINK_MESSAGES['not-parley']);
    const open = (): void => {
      const check = pairing.fromLink(url);
      if (check === 'ok') router.replace('/pair/flow');
      else setMessage(LINK_MESSAGES[check]);
    };
    // A pairing is under way: never drop it silently (D1 §6).
    if (!pairing.isBusy()) return open();
    Alert.alert('Pairing in progress', 'A new pairing link arrived. Switch to it and drop the current pairing?', [
      { text: 'Keep current', style: 'cancel', onPress: () => router.replace('/pair/flow') },
      { text: 'Use new link', style: 'destructive', onPress: open },
    ]);
  }, []);
  if (message === null) return null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text allowFontScaling accessibilityRole="header" style={[typography.title3, { color: colors.label }]}>
        {message}
      </Text>
      <PlainButton title="Close" onPress={() => router.replace('/')} />
    </View>
  );
}
