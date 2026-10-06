/**
 * Значок файла или папки (спека значков 2026-10-06, раздел 5): адрес SVG даёт пакет `@parley/file-icons`,
 * окно о наборе ничего не знает. Тема — из `useUiStore`, как у значка провайдера (`AgentIcon`), и
 * переключается на лету.
 *
 * Картинка `<img>`, а не встроенный `<svg>`: внутри файлов набора повторяются `id`, встроенные они бы
 * столкнулись. Значок декоративный — имя стоит рядом, поэтому `alt` пустой. Перетаскивать его нельзя:
 * строки дерева перетаскиваются целиком.
 */

import { fileIconUrl, folderIconUrl } from '@parley/file-icons';
import { useUiStore } from '../store/ui.js';

export interface FileTypeIconProps {
  /** Имя или путь от корня: значок ищется по имени и по двум последним сегментам пути. */
  path: string;
  kind?: 'file' | 'folder';
  /** У папки: раскрыта ли — у раскрытой свой значок. */
  open?: boolean;
  /** Сторона квадрата, px: 16 в списках, 14 во вкладках (спека 3). */
  size?: number;
  /** Вид файла вкладки (`files/file-kind.ts`) — метка `data-file-kind`, за неё держатся тесты вкладок. */
  fileKind?: string;
}

export function FileTypeIcon({ path, kind = 'file', open = false, size = 16, fileKind }: FileTypeIconProps): JSX.Element {
  const theme = useUiStore((state) => (state.dark ? 'dark' : 'light'));
  const src = kind === 'folder' ? folderIconUrl(path, open, theme) : fileIconUrl(path, theme);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      data-file-icon=""
      data-file-kind={fileKind}
      className="block shrink-0"
      style={{ width: size, height: size }}
    />
  );
}
