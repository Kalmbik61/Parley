import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';
import { truncate } from '../format.js';
import { glyphs, type Glyphs } from '../glyphs.js';
import { gap, pad, zoneBg } from '../theme/fill.js';
import { theme } from '../theme/index.js';
import type { StatusEvent } from '../use-status.js';

export interface StatusBarProps {
  /** Непросмотренные события: число рядом с флажком (дизайн 5). */
  count: number;
  event: Pick<StatusEvent, 'text' | 'hint'> | null;
  width: number;
  /** Имя префикса в подсказке и в списке действий (дизайн TUI v2, 3.1). */
  prefix: string;
  /** Нажат префикс, ждём вторую клавишу: вместо события — список действий (§3). */
  awaiting?: boolean;
  /**
   * Фокус в сайдбаре: второй признак режима навигации рядом с cyan-разделителем
   * (макет 1.5). Вместо события — что делают клавиши.
   */
  navigating?: boolean;
}

/**
 * Действия префикса в порядке макета §3. Отбрасываются с конца, пока строка не
 * влезет; `? все` не отбрасывается никогда.
 */
const ACTIONS: readonly string[] = [
  'c новая',
  'w работы',
  'g история',
  'i детали',
  's сайдбар',
  'j/k сессии',
  'x закрыть',
  't комната',
  // Настройки стоят перед самым длинным пунктом нарочно: список отбрасывается
  // с конца, и в хвосте они не показались бы почти никогда.
  ', настройки',
  'r возобновить',
];
const HELP = '? все';

/** Список действий по ширине: с конца, пока влезает (макеты §3). */
function prefixHint(prefix: string, width: number): string {
  const head = ` ${prefix} … `;
  const room = Math.max(0, width - head.length);
  for (let count = ACTIONS.length; count > 0; count--) {
    const line = [...ACTIONS.slice(0, count), HELP].join(' · ');
    if (line.length <= room) return `${head}${line}`;
  }
  return `${head}${HELP}`;
}

/**
 * Что делают клавиши в режиме навигации (макет 1.5). Стрелок в запасном наборе
 * нет — вместо них слово: буквы `io` за стрелки не сойдут (6.1).
 */
const navigationHint = (g: Glyphs): string =>
  `сайдбар · ${g.ascii ? 'стрелки' : `${g.up}${g.down}`}/jk — по строкам · Enter — подключить · Esc — в панель`;

/**
 * Строка статуса — единственный канал уведомлений (дизайн координации TUI, 5).
 * Живёт вне сетки сайдбара, на всю ширину терминала. Четыре состояния макетов
 * §3: пустое, событие `⚑`, ожидание второй клавиши префикса и предупреждение
 * (оно приходит обычным событием).
 */
export function StatusBar({
  count,
  event,
  width,
  prefix,
  awaiting = false,
  navigating = false,
}: StatusBarProps): ReactNode {
  const g = glyphs();
  const tail = `${prefix} ?`;
  const fills = theme().fills;

  // Пока ждём вторую клавишу, справа ничего нет: подсказка занимает всю строку.
  if (awaiting) {
    const content = prefixHint(prefix, width);
    return (
      <Box width={width}>
        <Text wrap="truncate" {...zoneBg(theme().bg.status)}>
          {content}
          {fills ? pad(stringWidth(content), width) : ''}
        </Text>
      </Box>
    );
  }

  // Строка события начинается с пробела, как в макете; хвост стоит у правого
  // края, между ними остаётся зазор (макеты §3).
  const room = Math.max(0, width - tail.length - 3);

  // Режим навигации занимает левую часть строки вместо события (макет 1.5).
  if (navigating) {
    const left = ` ${truncate(navigationHint(g), room, g.ellipsis)}`;
    // Фон зоны красит строку одним `<Text>` целиком (5.1): `justifyContent:
    // 'space-between'` оставлял бы зазор между левой и правой частью на фоне
    // терминала, а не строки. Без заливки — прежняя раскладка `Box`.
    if (fills) {
      return (
        <Box width={width}>
          <Text wrap="truncate" {...theme().bg.status}>
            {left}
            {gap(left, tail, width)}
            <Text {...theme().fg.muted}>{tail}</Text>
          </Text>
        </Box>
      );
    }
    return (
      <Box width={width} justifyContent="space-between">
        <Text wrap="truncate">{left}</Text>
        <Text {...theme().fg.muted}>{tail}</Text>
      </Box>
    );
  }

  const flag = count > 1 ? `${g.flag}${count}` : g.flag;
  const head = event === null ? '' : `${flag} ${event.text}`;
  const hint = event === null || event.hint === undefined ? '' : ` · ${event.hint}`;
  const left = truncate(`${head}${hint}`, room, g.ellipsis);
  const leftText = event === null ? '' : ` ${left}`;
  const leftContent =
    event === null ? (
      ''
    ) : (
      <>
        {' '}
        <Text {...theme().status.warn} bold>
          {left.slice(0, flag.length)}
        </Text>
        {left.slice(flag.length)}
      </>
    );

  if (fills) {
    return (
      <Box width={width}>
        <Text wrap="truncate" {...theme().bg.status}>
          {leftContent}
          {gap(leftText, tail, width)}
          <Text {...theme().fg.muted}>{tail}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate">{leftContent}</Text>
      <Text {...theme().fg.muted}>{tail}</Text>
    </Box>
  );
}
