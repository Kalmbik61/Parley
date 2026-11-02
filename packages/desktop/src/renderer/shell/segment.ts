/**
 * Кнопка-сегмент правой группы строки статуса: пилюля, основной цвет и на hover — вторичный текст на заливке ниже 4.5:1.
 * Ниже 960 px поля уже (px-0.5): имена провайдеров важнее воздуха между сегментами.
 * Общая для `StatusBar` и `DiagnosticsSegment`: в одном файле они импортировали бы друг друга по кругу.
 */
export const SEGMENT_BUTTON = 'shrink-0 rounded-full px-0.5 py-0.5 text-foreground min-[960px]:px-2 transition-colors hover:bg-foreground/8';
