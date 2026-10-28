/**
 * Куда вид хозяина открывает ссылки из своей ленты: `PanelHost` ставит сюда открытие в панель браузера хозяина (чат
 * сессии, лента комнаты). Нет контекста (почта, превью файлов) — у ссылки нет хозяина панели, и она открывается вкладкой
 * (`RoomMarkdown`).
 */

import { createContext } from 'react';

export const PanelLinkContext = createContext<((url: string) => void) | null>(null);
