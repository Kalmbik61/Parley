// Entry of `parley://pair?…` (opened from the system Camera or any web page): always the confirm screen (D1 §6.3).
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { PlainButton } from '../../components/ui';
import { pairing } from '../../pairing/instance';
import { linkFromParams } from '../../pairing/session';
import { typography, useColors } from '../../theme';

export default function PairLink() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const colors = useColors();
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const url = linkFromParams(params);
    if (url !== null && pairing.fromLink(url)) router.replace('/pair/flow');
    else setBad(true);
  }, []);
  if (!bad) return null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text allowFontScaling accessibilityRole="header" style={[typography.title3, { color: colors.label }]}>
        This isn't a Parley pairing code
      </Text>
      <PlainButton title="Close" onPress={() => router.replace('/')} />
    </View>
  );
}
