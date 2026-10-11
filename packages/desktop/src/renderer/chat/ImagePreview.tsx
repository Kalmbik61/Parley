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
 * придёт, в диалоге стоит миниатюра строки. Рамка диалога сразу своего размера — доли окна, а не размер картинки, —
 * и картинка вписана в неё целиком (`object-contain`), поэтому приход большой версии на диалог не влияет: он не прыгает.
 *
 * Фокус при закрытии возвращается на миниатюру; нет её (строку размонтировал виртуальный список) — на помеченный
 * `data-preview-return` предок строки, прокрутчик ленты, чтобы человек с клавиатуры не терял место в ленте.
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
/** Предок строки, на который вернуть фокус, если самой строки к закрытию уже нет (прокрутчик ленты, `FeedList`). */
const RETURN_FOCUS = '[data-preview-return]';

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
  /** Помеченный предок `opener` на момент открытия: после размонтирования строки по ней его уже не найти. */
  fallback: HTMLElement | null;
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
  const open = useCallback<OpenImagePreview>(
    (target, opener) => setShown({ target, opener, fallback: opener?.closest<HTMLElement>(RETURN_FOCUS) ?? null, open: true }),
    [],
  );

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
            // Рамка сразу своего размера (доли окна, предел — размер большой версии и поля у края окна), а не по картинке:
            // иначе диалог сначала вырос бы вокруг миниатюры, а потом прыгнул под большую версию. Крестик диалога лежит
            // поверх угла картинки, а скриншоты бывают любого цвета, поэтому у него своя подложка и полная непрозрачность.
            className="h-[85vh] w-[90vw] max-h-[min(1240px,calc(100dvh-2rem))] max-w-[min(1640px,calc(100vw-2rem))] [&>button]:bg-background/85 [&>button]:p-1 [&>button]:opacity-100"
            // Триггера у диалога нет (он не в строке), и Радикс фокус не вернёт: возвращаем на миниатюру, если строка жива,
            // иначе — на прокрутчик ленты.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              [shown.opener, shown.fallback].find((element) => element?.isConnected === true)?.focus();
            }}
          >
            <DialogTitle className="sr-only">{shown.target.label}</DialogTitle>
            {/* Тело занимает всю рамку; картинка лежит в нём абсолютно (отступ 4 px гасит поля `-m-1 p-1` тела диалога),
                поэтому размер рамки от неё не зависит. */}
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-1">
                {/* `key`: просьба про другую картинку при ещё не закрытом диалоге не должна показать большую версию прежней. */}
                <PreviewImage key={shown.target.path} bridge={bridge} target={shown.target} />
              </div>
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
      className="size-full object-contain"
    />
  );
}
