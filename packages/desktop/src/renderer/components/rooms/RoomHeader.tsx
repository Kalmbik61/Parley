/**
 * Шапка ленты комнаты (кусок 3.6 плана окна, спека 6.3): название и
 * участники — `S01 (Opus 5.5) · S03 (Codex) · Вы`. В отличие от шапки «всей
 * почты работы» (`MailPanel.tsx`) счёта писем тут нет — состав участников
 * комнаты фиксирован (`Room.creator`/`Room.members`), а не собирается по
 * переписке.
 *
 * Кусок 1.4 плана «облик Orca»: токены вместо старой палитры темы окна.
 */

export interface RoomHeaderProps {
  title: string;
  participants: string[];
}

export function RoomHeader({ title, participants }: RoomHeaderProps): JSX.Element {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="truncate text-sm font-medium text-foreground">{title}</div>
      <div className="truncate text-xs text-muted-foreground">{participants.join(' · ')}</div>
    </div>
  );
}
