/**
 * Просмотр картинки из результата инструмента: один диалог на вид «Chat», вне строк ленты. Лента виртуальная —
 * строку, которая открыла просмотр, список размонтирует, как только она уйдёт из окна (агент работает дальше, лента
 * прилипла к низу, новые строки сдвигают старые), а вместе со строкой ушёл бы и диалог, будь он её частью. Поэтому
 * строка (`ToolImages`) только просит открыть (`useOpenImagePreview`), а диалог и его состояние держит
 * `ImagePreviewHost` — над лентой, в `ChatView`.
 *
 * Состояние у каждого вида своё (`useState`, не общий стор): разделённые группы держат смонтированными несколько видов
 * разом, а общий стор открыл бы диалог в каждом из них и требовал бы уборки при размонтировании. Просмотр закрывается,
 * когда вид уходит с экрана (размонтирование) и когда сессия вида другая (`sessionKey`) или работа скрыта
 * (`visible: false` — контейнеры трёх работ LRU остаются смонтированными, скрытыми и `inert`, а диалог в `body`, вне них).
 * Вернувшись, человек просмотр сам не откроет.
 *
 * Большая версия — `PREVIEW_PX` по длинной стороне отдельным запросом, мимо кэша миниатюр: пока она в пути и если не
 * придёт, в диалоге стоит миниатюра строки.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.js';

/** Длинная сторона картинки в просмотре, px (main берёт до 2048). */
const PREVIEW_PX = 1600;

export interface ImagePreviewTarget {
  /** Абсолютный путь картинки: по нему просится большая версия. */
  path: string;
  /** Подпись для скринридера, она же имя диалога: `Image 2 of 3`. */
  label: string;
  /** Миниатюра строки: стоит в диалоге, пока большая версия в пути, и если она не придёт. */
  thumbnail: string;
}

/** `opener` — элемент, на который вернуть фокус при закрытии, если строка к тому времени ещё в DOM. */
type OpenImagePreview = (target: ImagePreviewTarget, opener: HTMLElement | null) => void;

const OpenImagePreviewContext = createContext<OpenImagePreview | null>(null);

/** Просьба открыть просмотр; `null` — хоста нет (элемент вне `ChatView`), просить некого. */
export function useOpenImagePreview(): OpenImagePreview | null {
  return useContext(OpenImagePreviewContext);
}

interface Shown {
  target: ImagePreviewTarget;
  opener: HTMLElement | null;
  /** Закрытый диалог остаётся здесь до следующей просьбы: Radix доигрывает его исчезновение. */
  open: boolean;
}

export interface ImagePreviewHostProps {
  bridge: ParleyBridge;
  sessionKey: string;
  /** Работа видима; у скрытой просмотр закрыт. */
  visible: boolean;
  children: ReactNode;
}

export function ImagePreviewHost({ bridge, sessionKey, visible, children }: ImagePreviewHostProps): JSX.Element {
  const [shown, setShown] = useState<Shown | null>(null);
  // Другая сессия или скрытая работа: до отрисовки, чтобы чужая картинка не мелькнула ни на кадр.
  useLayoutEffect(() => {
    setShown(null);
  }, [sessionKey, visible]);
  // Ссылка не меняется никогда: открытие и закрытие просмотра не перерисовывают строки ленты (они читают только её).
  const open = useCallback<OpenImagePreview>((target, opener) => setShown({ target, opener, open: true }), []);

  return (
    <OpenImagePreviewContext.Provider value={open}>
      {children}
      <Dialog
        open={shown?.open ?? false}
        onOpenChange={(next) => {
          if (!next) setShown((was) => (was === null ? null : { ...was, open: false }));
        }}
      >
        {shown === null ? null : (
          <DialogContent
            aria-describedby={undefined}
            // Шире обычного диалога (`max-w-lg`): большая картинка иначе ушла бы в горизонтальную прокрутку тела. Крестик
            // диалога лежит поверх угла картинки, а скриншоты бывают любого цвета, поэтому у него своя подложка и полная
            // непрозрачность.
            className="w-fit max-w-[calc(100vw-2rem)] [&>button]:bg-background/85 [&>button]:p-1 [&>button]:opacity-100"
            // Триггера у диалога нет (он не в строке), и Радикс фокус не вернёт: возвращаем на миниатюру, если строка жива.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (shown.opener?.isConnected === true) shown.opener.focus();
            }}
          >
            <DialogTitle className="sr-only">{shown.target.label}</DialogTitle>
            <div className="flex justify-center">
              {/* `key`: просьба про другую картинку при ещё не закрытом диалоге не должна показать большую версию прежней. */}
              <PreviewImage key={shown.target.path} bridge={bridge} target={shown.target} />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </OpenImagePreviewContext.Provider>
  );
}

/** Содержимое диалога живёт, пока он открыт (Radix монтирует его на открытие): запрос большой версии идёт только тогда. */
function PreviewImage({ bridge, target }: { bridge: ParleyBridge; target: ImagePreviewTarget }): JSX.Element {
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    bridge.app.imageThumbnail(target.path, PREVIEW_PX).then(
      (url) => {
        if (mounted) setFull(url);
      },
      // Большая версия не пришла — остаётся миниатюра.
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [bridge, target.path]);
  return (
    <img
      data-testid="chat-tool-image-view"
      src={full ?? target.thumbnail}
      alt={target.label}
      className="max-h-[85vh] max-w-[90vw] object-contain"
    />
  );
}
