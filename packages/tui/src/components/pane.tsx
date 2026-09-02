import { Box, measureElement, Text, type DOMElement } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface PaneSize {
  width: number;
  height: number;
}

export interface PaneProps {
  title: string;
  active: boolean;
  /**
   * Содержимое получает фактический размер своей области.
   *
   * Считать ширину и высоту формулами по размеру терминала — гадание: рамки,
   * отступы и проценты Yoga считает сам, и результат расходится с прикидкой.
   * Поэтому меряем настоящий элемент.
   */
  children: (size: PaneSize) => ReactNode;
  flexGrow?: number;
  width?: number | string;
  minWidth?: number;
}

const SAME = (a: PaneSize, b: PaneSize): boolean => a.width === b.width && a.height === b.height;

/** Рамка с заголовком. Активная панель подсвечена — так требует specs/ui.md. */
export function Pane({ title, active, children, flexGrow, width, minWidth }: PaneProps): ReactNode {
  const inner = useRef<DOMElement>(null);
  const [size, setSize] = useState<PaneSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (inner.current === null) return;
    const measured = measureElement(inner.current);
    // Сравниваем перед записью: иначе замер после каждого рендера зациклит его.
    if (!SAME(measured, size)) setSize(measured);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : 'gray'}
      paddingX={1}
      overflow="hidden"
      {...(flexGrow === undefined ? {} : { flexGrow })}
      {...(width === undefined ? {} : { width })}
      {...(minWidth === undefined ? {} : { minWidth })}
    >
      <Text bold color={active ? 'cyan' : 'gray'}>
        {title}
      </Text>
      <Box ref={inner} flexGrow={1} flexDirection="column" overflow="hidden">
        {children(size)}
      </Box>
    </Box>
  );
}
