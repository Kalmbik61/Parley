import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRange, appendMessage, journalFile, readCursorFile, readMessages, RoomGoneError, withCursors } from './journal.js';
import { markHumanRead } from './letters.js';
import { addMessage, addSession, removeSession } from './map.js';
import { resolveProposal, setProposal } from './proposals.js';
import { addRoom, addSystemMessage, archiveRoom, deleteRoom, reopenRoom } from './rooms.js';
import { createWork, LettersWrittenIndexNotError, MapLockTimeoutError, readMap, updateMap, workPaths, worksIndexPath } from './store.js';
import { HUMAN, PARLEY, type WorkMap } from './types.js';

/**
 * Письма из мутаторов `updateMap` на карте-журнале (v3): `addMessage` внутри мутатора кладёт строку в журнал комнаты,
 * `readBy` становится курсором, удаление комнаты уносит её журнал.
 */

let home = '';
let project = '';
let workId = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'sink' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 't' });
    for (const session of map.sessions) session.lifecycle = 'active';
    addRoom(map, { title: 'one', creator: 's-01', members: ['s-02', 's-03'], lead: 's-01' });
    addRoom(map, { title: 'two', creator: 's-01', members: ['s-02'], lead: 's-01' });
  });
  // v2 → v3: письма в журналах, индекс без них.
  const file = workPaths(project, workId).map;
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  raw['schemaVersion'] = 3;
  delete raw['messages'];
  delete raw['decisionExports'];
  await writeFile(file, JSON.stringify(raw, null, 2));
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const letters = (roomId: string | null) => readMessages(project, workId, roomId, { limit: Infinity, maxBytes: Infinity });
const indexText = (): Promise<string> => readFile(workPaths(project, workId).map, 'utf8');

describe('addMessage в мутаторе updateMap на карте-журнале', () => {
  it('письмо ложится строкой в журнал своей комнаты с настоящим id, а в индекс не попадает', async () => {
    let id = '';
    await updateMap(project, workId, (map) => {
      id = addMessage(map, { from: 's-01', to: ['s-02'], roomId: 'r-01', text: 'привет' }).id;
    });
    expect(id).toBe('m-r01-1');
    expect((await letters('r-01')).map((letter) => [letter.id, letter.text])).toEqual([['m-r01-1', 'привет']]);
    expect(await indexText()).not.toContain('привет');
    expect((await readMap(project, workId)).messages.map((message) => message.id)).toEqual(['m-r01-1']);
  });

  it('номера идут за письмами, которые уже в журнале (send_message пишет мимо карты), и не повторяются', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'раз' });
    let ids: string[] = [];
    await updateMap(project, workId, (map) => {
      ids = [
        addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'два' }).id,
        addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'три' }).id,
        addMessage(map, { from: 's-01', to: ['s-02'], text: 'прямое' }).id,
      ];
    });
    expect(ids).toEqual(['m-r01-2', 'm-r01-3', 'm-d-1']);
    expect((await letters('r-01')).map((letter) => letter.seq)).toEqual([1, 2, 3]);
    expect((await letters(null)).map((letter) => letter.id)).toEqual(['m-d-1']);
  });

  it('мутатор, который упал после addMessage, не оставляет письма: журнал не тронут, замок снят', async () => {
    await expect(
      updateMap(project, workId, (map) => {
        addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'не должно лечь' });
        throw new Error('отказ');
      }),
    ).rejects.toThrow('отказ');
    expect(await letters('r-01')).toEqual([]);
    expect(await readdir(path.dirname(journalFile(workPaths(project, workId), 'r-01')))).not.toContain('messages.lock');
    // Замок снят: следующая запись не ждёт.
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'после' });
  });

  it('мутатор видит добавленное письмо в map.messages, как на v2', async () => {
    let seen: string[] = [];
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'своё' });
      seen = map.messages.map((message) => message.text);
    });
    expect(seen).toEqual(['своё']);
  });

  it('readBy, поставленный после addMessage, — диапазон из одного письма, а не «прочитано по него»; соседний с прочитанным склеивается', async () => {
    const cursorJson = async () => JSON.parse(await readFile(path.join(workPaths(project, workId).cursors, `${HUMAN}.json`), 'utf8')) as unknown;
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'старое' });
    await updateMap(project, workId, (map) => {
      const line = addMessage(map, { from: 'system', to: [HUMAN], roomId: 'r-01', text: 'строка' });
      line.readBy[HUMAN] = line.at;
    });
    // «Старое» осталось непрочитанным, а строка отмечена отдельно.
    expect(await cursorJson()).toEqual({ 'r-01': [[2, 2]] });
    // Явное «прочёл» по «старому» добавляет письмо 1 и склеивается с отметкой вплотную за ним.
    await markHumanRead(project, workId, ['m-r01-1']);
    expect(await cursorJson()).toEqual({ 'r-01': [[1, 2]] });
    // Две отметки подряд вплотную за прочитанным склеиваются целиком.
    await updateMap(project, workId, (map) => {
      for (const text of ['раз', 'два']) {
        const line = addMessage(map, { from: 'system', to: [HUMAN], roomId: 'r-01', text });
        line.readBy[HUMAN] = line.at;
      }
    });
    expect(await cursorJson()).toEqual({ 'r-01': [[1, 4]] });
    // Прочитанное впереди отмеченного письма назад не возвращается, повторная отметка уже прочитанного файл не меняет.
    await mkdir(workPaths(project, workId).cursors, { recursive: true });
    await writeFile(path.join(workPaths(project, workId).cursors, `${HUMAN}.json`), JSON.stringify({ 'r-01': [[1, 9]] }));
    await updateMap(project, workId, (map) => {
      const line = addMessage(map, { from: 'system', to: [HUMAN], roomId: 'r-01', text: 'позже' });
      line.readBy[HUMAN] = line.at;
    });
    expect(await cursorJson()).toEqual({ 'r-01': [[1, 9]] });
  });
});

describe('замок журнала занят асинхронным писателем', () => {
  const lockOf = (roomId: string) => path.join(path.dirname(journalFile(workPaths(project, workId), roomId)), 'messages.lock');

  it('мутатор ждёт асинхронно: цикл событий идёт, после отпускания замка письмо ложится, ничего не потеряно', async () => {
    const lock = lockOf('r-01');
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '');
    const events: string[] = [];
    setTimeout(() => events.push('timer'), 30);
    setTimeout(() => {
      events.push('released');
      rmSync(lock);
    }, 120);
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'после ожидания' });
      events.push('mutated');
    });
    // Таймер сработал, пока мутатор ждал: цикл событий не стоял; письмо легло только после отпускания.
    expect(events).toEqual(['timer', 'released', 'mutated']);
    expect((await letters('r-01')).map((letter) => letter.text)).toEqual(['после ожидания']);
  });

  it('настоящие appendMessage рядом с мутатором: письма не теряются, номера подряд без повторов', async () => {
    const appends = Array.from({ length: 20 }, (_, i) => appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: `a${i}` }));
    const mutated = updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'из мутатора' });
    });
    await Promise.all([...appends, mutated]);
    const all = await letters('r-01');
    expect(all.map((letter) => letter.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(all.filter((letter) => letter.text === 'из мутатора')).toHaveLength(1);
  });

  it('замок не отпущен за таймаут: MapLockTimeoutError, в журнале ничего нет, замок приёмника не оставлен', async () => {
    const lock = lockOf('r-01');
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '');
    await expect(
      updateMap(project, workId, (map) => void addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'x' }), { lockTimeoutMs: 150 }),
    ).rejects.toBeInstanceOf(MapLockTimeoutError);
    expect(await letters('r-01')).toEqual([]);
    // Свой замок мутатор на другой комнате не оставил: прямые письма пишутся сразу.
    await appendMessage(project, workId, null, { from: 's-02', to: ['s-01'], text: 'прямое' });
  });
});

describe('удаление комнаты на карте-журнале', () => {
  it('уносит журнал комнаты, его замок и курсоры на неё; чужая комната и прямые письма целы', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'в первой' });
    await appendMessage(project, workId, 'r-02', { from: 's-02', to: [], text: 'во второй' });
    await appendMessage(project, workId, null, { from: 's-02', to: ['s-01'], text: 'прямое' });
    await updateMap(project, workId, (map) => {
      // s-03 уйдёт из комнат, получит прощальное письмо в прямой журнал.
      deleteRoom(map, 'r-01');
    });
    const paths = workPaths(project, workId);
    await expect(stat(path.dirname(journalFile(paths, 'r-01')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await letters('r-02')).map((letter) => letter.text)).toEqual(['во второй']);
    expect((await letters(null)).map((letter) => letter.text)).toContain('прямое');
    expect((await readMap(project, workId)).rooms.map((room) => room.id)).toEqual(['r-02']);
  });

  it('поздний send_message в удалённую комнату отказывает и не воскрешает журнал', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'в первой' });
    // Письмо прошло проверку членства, потом комнату удалили, и только теперь дописывается строка.
    await updateMap(project, workId, (map) => void deleteRoom(map, 'r-01'));
    await expect(appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'поздно' })).rejects.toBeInstanceOf(RoomGoneError);
    await expect(stat(path.dirname(journalFile(workPaths(project, workId), 'r-01')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('каталог, пересозданный в окне до записи индекса, уносится вместе с удалением комнаты', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'в первой' });
    const dir = path.dirname(journalFile(workPaths(project, workId), 'r-01'));
    let writeLate: Promise<unknown> = Promise.resolve();
    await updateMap(project, workId, (map) => {
      deleteRoom(map, 'r-01');
      // Опоздавшая запись стартует, пока индекс ещё с комнатой: проверка её пропускает, а удаление идёт после индекса.
      writeLate = appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'в окне' }).catch(() => undefined);
    });
    await writeLate;
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readMap(project, workId)).rooms.map((room) => room.id)).toEqual(['r-02']);
  });

  it('курсоры всех сессий теряют запись о комнате', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'раз' });
    await appendMessage(project, workId, 'r-02', { from: 's-01', to: ['s-02'], text: 'два' });
    const paths = workPaths(project, workId);
    await mkdir(paths.cursors, { recursive: true });
    await writeFile(path.join(paths.cursors, 's-02.json'), JSON.stringify({ 'r-01': [[1, 1]], 'r-02': [[1, 1]] }));
    await updateMap(project, workId, (map) => void deleteRoom(map, 'r-01'));
    expect(await readCursorFile(project, workId, 's-02')).toEqual({ 'r-02': [[1, 1]] });
  });

  it('messageSeq на v3 не пересчитывается: поле остаётся как было', async () => {
    await updateMap(project, workId, (map) => {
      map.work.messageSeq = 7;
    });
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: 'раз' });
    await updateMap(project, workId, (map) => void deleteRoom(map, 'r-01'));
    expect((await readMap(project, workId)).work.messageSeq).toBe(7);
  });
});

describe('возврат комнаты из архива и решения на карте-журнале', () => {
  it('reopenRoom ставит участникам курсор на последнее письмо до строки о возврате', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'до архива' });
    await updateMap(project, workId, (map) => void archiveRoom(map, 'r-01'));
    await updateMap(project, workId, (map) => reopenRoom(map, 'r-01'));
    const all = await letters('r-01');
    expect(all.map((letter) => letter.text)).toEqual(['до архива', 'Room archived by the human.', 'Room reopened by the human.']);
    // s-02 была адресатом первого письма; архивная комната адресатов не имела, курсор — по последнему письму до возврата.
    expect((await readCursorFile(project, workId, 's-02'))['r-01']).toEqual([[1, all[1]!.seq]]);
  });

  it('принятое решение: письмо в журнале комнаты и запись в decisions.json с id письма журнала', async () => {
    await updateMap(project, workId, (map) => void setProposal(map, 'r-01', 's-01', 'делаем так'));
    let messageId = '';
    await updateMap(project, workId, (map) => {
      messageId = resolveProposal(map, 'r-01', 'p-01', 'accept').messageId;
    });
    expect(messageId).toMatch(/^m-r01-\d+$/);
    const decision = (await letters('r-01')).find((letter) => letter.id === messageId);
    expect(decision).toMatchObject({ kind: 'decision', text: 'делаем так', from: 's-01' });
    const stored = JSON.parse(await readFile(workPaths(project, workId).decisions, 'utf8')) as { messageId: string; status: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ messageId, status: 'pending' });
    expect(await indexText()).not.toContain('decisionExports');
  });
});

describe('прочие писатели писем на карте-журнале', () => {
  it('письма plan-effects, recipe-lead и системные строки комнат проходят без отказа охраны', async () => {
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'от parley' });
    });
    expect((await letters('r-01')).map((letter) => letter.from)).toEqual([PARLEY]);
  });

  it('removeSession не трогает письма; метку deleted выводит сборщик из work.deletedSessions', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-03', to: [], text: 'от третьей' });
    await updateMap(project, workId, (map) => void removeSession(map, 's-03'));
    const map = await readMap(project, workId);
    expect(map.messages[0]!.deleted).toBe(true);
    expect((await letters('r-01'))[0]).not.toHaveProperty('deleted');
  });

  it('markHumanRead на v3 ставит курсор человека на самое новое отмеченное письмо журнала', async () => {
    for (const text of ['один', 'два', 'три']) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text });
    expect(await markHumanRead(project, workId, ['m-r01-2'])).toBe(1);
    expect(await readCursorFile(project, workId, HUMAN)).toEqual({ 'r-01': [[1, 2]] });
    // Уже прочитанное и чужие id — ноль, курсор не двигается назад.
    expect(await markHumanRead(project, workId, ['m-r01-1', 'm-r01-2', 'm-нет'])).toBe(0);
    expect(await readCursorFile(project, workId, HUMAN)).toEqual({ 'r-01': [[1, 2]] });
  });
});

describe('отметки прочтения не врут: системная строка не гасит письма человеку', () => {
  const cursorText = (): Promise<string> => readFile(path.join(workPaths(project, workId).cursors, `${HUMAN}.json`), 'utf8');
  const humanRead = async (): Promise<Record<string, boolean>> =>
    Object.fromEntries((await readMap(project, workId)).messages.map((message) => [message.id, message.readBy[HUMAN] !== undefined]));
  const systemLine = (text: string) =>
    updateMap(project, workId, (map) => {
      addSystemMessage(map, 'r-01', text);
    });

  it('системная строка при двух старых непрочитанных письмах человеку оставляет их непрочитанными, сама прочитана', async () => {
    for (const text of ['вопрос один', 'вопрос два']) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text });
    await systemLine('строка');
    expect(await humanRead()).toEqual({ 'm-r01-1': false, 'm-r01-2': false, 'm-r01-3': true });
    // В файле только сама строка: диапазон из одного письма, а не «прочитано по третье».
    expect(JSON.parse(await cursorText())).toEqual({ 'r-01': [[3, 3]] });
  });

  it('явный markHumanRead самого нового письма склеивает отметки в один диапазон', async () => {
    for (const text of ['вопрос один', 'вопрос два']) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text });
    await systemLine('строка');
    expect(await markHumanRead(project, workId, ['m-r01-2'])).toBe(1);
    expect(await humanRead()).toEqual({ 'm-r01-1': true, 'm-r01-2': true, 'm-r01-3': true });
    // Отметка внутри прочитанного не остаётся: в файле один диапазон.
    expect(JSON.parse(await cursorText())).toEqual({ 'r-01': [[1, 3]] });
  });

  it('отметка вплотную за прочитанным сразу склеивается с ним', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text: 'вопрос' });
    await markHumanRead(project, workId, ['m-r01-1']);
    await systemLine('строка');
    expect(JSON.parse(await cursorText())).toEqual({ 'r-01': [[1, 2]] });
  });

  it('файл курсоров не растёт после длинной череды системных строк за непрочитанным письмом', async () => {
    await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text: 'вопрос' });
    for (let i = 0; i < 150; i += 1) {
      await updateMap(project, workId, (map) => {
        for (let k = 0; k < 4; k += 1) addSystemMessage(map, 'r-01', `строка ${i}-${k}`);
      });
    }
    expect((await humanRead())['m-r01-1']).toBe(false);
    expect(JSON.parse(await cursorText())).toEqual({ 'r-01': [[2, 601]] });
    expect((await cursorText()).length).toBeLessThan(4096);
  });
});

describe('markHumanRead не двигает курсор назад', () => {
  const cursorFileOf = () => path.join(workPaths(project, workId).cursors, `${HUMAN}.json`);

  it('устаревший вызов со старым id оставляет курсор на месте и сообщает 0', async () => {
    for (const text of ['один', 'два', 'три']) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text });
    // Курсорный замок держит «чужой» вызов: устаревший markHumanRead успевает прочитать карту (письмо 1 ему непрочитано)
    // и встаёт в очередь на замок; пока он ждёт, чужой вызов прочитанным 1–3.
    let stale = -1;
    await withCursors(project, workId, HUMAN, async (file) => {
      const call = markHumanRead(project, workId, ['m-r01-1']).then((count) => void (stale = count));
      await new Promise((resolve) => setTimeout(resolve, 150));
      addRange(file, 'r-01', 1, 3);
      void call;
      return { changed: true, value: undefined };
    });
    await vi.waitFor(() => expect(stale).not.toBe(-1));
    expect(JSON.parse(await readFile(cursorFileOf(), 'utf8'))).toEqual({ 'r-01': [[1, 3]] });
    expect(stale).toBe(0);
  });

  it('два одновременных вызова заканчиваются на более новом курсоре в любом порядке', async () => {
    for (const text of ['один', 'два', 'три']) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [HUMAN], text });
    await Promise.all([markHumanRead(project, workId, ['m-r01-1']), markHumanRead(project, workId, ['m-r01-3'])]);
    expect(JSON.parse(await readFile(cursorFileOf(), 'utf8'))).toEqual({ 'r-01': [[1, 3]] });
  });
});

describe('отказ записи индекса после записи писем', () => {
  const indexLock = (): string => path.join(path.dirname(worksIndexPath()), 'works-index.lock');
  const deliver = (map: WorkMap): void => {
    const letter = addMessage(map, { from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'доставка плана' });
    (map.planEffects ??= []).push({
      key: 'r-01/mode/0/0/mode/0/s-02', roomId: 'r-01', planId: null, rev: 0, item: null, kind: 'mode', occurrence: '0', target: 's-02',
      text: 'доставка плана', createdAt: letter.at, status: 'sent', messageId: letter.id,
    });
  };

  it('отказ индекса, который проходит при повторе внутри вызова, оставляет одно письмо и один sent-эффект', async () => {
    await writeFile(indexLock(), '');
    setTimeout(() => rmSync(indexLock(), { force: true }), 120);
    await updateMap(project, workId, deliver, { lockTimeoutMs: 100 });
    expect((await letters('r-01')).map((letter) => letter.text)).toEqual(['доставка плана']);
    const effects = (await readMap(project, workId)).planEffects ?? [];
    expect(effects.filter((effect) => effect.status === 'sent')).toHaveLength(1);
  });

  it('отказ индекса насовсем говорит, что письма записаны, а индекс нет; тип не MapLockTimeoutError', async () => {
    await writeFile(indexLock(), '');
    const failure: unknown = await updateMap(project, workId, deliver, { lockTimeoutMs: 40 }).catch((error: unknown) => error);
    rmSync(indexLock(), { force: true });
    expect(failure).toBeInstanceOf(LettersWrittenIndexNotError);
    expect(failure).not.toBeInstanceOf(MapLockTimeoutError);
    expect((failure as Error).message).toMatch(/letters are written to the journals but the index .* was NOT saved/);
    expect(await letters('r-01')).toHaveLength(1);
  });
});

describe('карта v2 не меняется', () => {
  it('addMessage без приёмника кладёт письмо в map.messages с id m-NN', () => {
    const map = { work: { messageSeq: 0 }, messages: [] } as unknown as WorkMap;
    expect(addMessage(map, { from: 's-01', to: [], text: 'x' }).id).toBe('m-01');
    expect(map.messages).toHaveLength(1);
  });
});
