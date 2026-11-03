// Developer build only: one Markdown demo text on a plain screen (A40 screenshots). `/md?case=table|code|path|lists|all`.
import { Redirect, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEV_BUILD } from '../dev/build';
import { MD_CASES } from '../dev/md-demo';
import { Markdown } from '../markdown/Markdown';
import { useColors } from '../theme';

export default function MdDemo() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { case: name, scrollX } = useLocalSearchParams<{ case?: string; scrollX?: string }>();
  if (!DEV_BUILD) return <Redirect href="/" />;
  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8 }}>
      <Markdown text={MD_CASES[name ?? 'all'] ?? MD_CASES.all!} labelOf={(id) => (id === 's-02' ? 'Editor' : id)} {...(scrollX === undefined ? {} : { tableOffset: Number(scrollX) })} />
    </ScrollView>
  );
}
