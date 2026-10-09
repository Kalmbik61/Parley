import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stashFeedImages } from '../images.js';
import { emptyFeedState } from '../reduce.js';
import { FEED_IMAGE_PATH_LIMIT, type FeedAgent, type FeedImageRef, type FeedItem, type FeedNotice, type FeedPrompt, type FeedText, type FeedTool, type FeedTurn } from '../types.js';
import { applyCodexRecords, CODEX_HISTORY_IN_TERMINAL, commandText, emptyCodexCursor, feedFromCodexRollout } from './apply-codex.js';
import { parseRolloutLine, type RolloutRecord } from './rollout-record.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const records = (name: string): RolloutRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.rollout.jsonl`), 'utf8')
    .split('\n')
    .map(parseRolloutLine)
    .filter((record): record is RolloutRecord => record !== null);
const ofKind = <K extends FeedItem['kind']>(items: readonly FeedItem[], kind: K): Array<Extract<FeedItem, { kind: K }>> =>
  items.filter((item): item is Extract<FeedItem, { kind: K }> => item.kind === kind);

describe('feedFromCodexRollout — основной тред', () => {
  const { state, cursor } = feedFromCodexRollout(records('codex-main'));

  it('порядок элементов ленты', () => {
    expect(state.items.map((item) => item.kind)).toEqual([
      'notice', 'prompt', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'text', 'turn', 'prompt', 'turn',
    ]);
  });

  it('модель из turn_context — заметка session-start; режим — approval · sandbox', () => {
    const notice = ofKind(state.items, 'notice')[0] as FeedNotice;
    expect(notice.notice).toEqual({ type: 'session-start', source: 'codex', model: 'gpt-6-astra' });
    expect(state.permissionMode).toBe('on-request · workspace-write');
  });

  it('промпт и итоговый текст', () => {
    expect((ofKind(state.items, 'prompt')[0] as FeedPrompt).text).toBe('Почини тесты ленты');
    const text = ofKind(state.items, 'text')[0] as FeedText;
    expect(text).toMatchObject({ text: 'Готово: тесты зелёные.', streaming: false, messageId: 'am1' });
  });

  it('команды: скрипт оболочки как есть, вывод, ненулевой код — failed', () => {
    const [cmd1, cmd2] = ofKind(state.items, 'tool') as FeedTool[];
    expect(cmd1).toMatchObject({ name: 'Bash', status: 'done', toolUseId: 'call_cmd1' });
    expect(cmd1?.input['command']).toBe('pnpm -C packages/core exec vitest run src/feed/codex --reporter=verbose 2>&1 | tail -n 40');
    expect(cmd1?.response?.text).toBe('Test Files 2 passed');
    expect(cmd2).toMatchObject({ name: 'Bash', status: 'failed' });
    expect(cmd2?.input['command']).toBe('git commit -m "fix: тесты"');
  });

  it('правка файла: Edit с хунками, Write без хунков, Delete', () => {
    const files = (ofKind(state.items, 'tool') as FeedTool[]).filter((tool) => ['Edit', 'Write', 'Delete'].includes(tool.name));
    expect(files.map((tool) => [tool.name, tool.input['file_path']])).toEqual([
      ['Edit', '/tmp/p/src/a.ts'], ['Write', '/tmp/p/src/new.ts'], ['Delete', '/tmp/p/src/old.ts'],
    ]);
    expect(files[0]?.patch?.[0]?.lines).toEqual([' const a = 1;', '-const b = 2;', '+const b = 3;']);
    expect(files[1]?.patch).toBeUndefined();
    expect(files[1]?.input['content']).toBe('export const x = 1;\n');
  });

  it('MCP — сервер и инструмент в имени, ответ текстом', () => {
    const mcp = (ofKind(state.items, 'tool') as FeedTool[]).find((tool) => tool.name.startsWith('mcp__'));
    expect(mcp).toMatchObject({ name: 'mcp__parley__report', input: { status: 'done' }, status: 'done' });
    expect(mcp?.response?.text).toBe('ok');
  });

  it('конец хода; прерванный ход — interrupted', () => {
    const [done, aborted] = ofKind(state.items, 'turn') as FeedTurn[];
    expect(done?.interrupted).toBeUndefined();
    expect(aborted?.interrupted).toBe(true);
  });

  it('незнакомый тип элемента считается и пропускается; журнал современный', () => {
    expect(cursor.skipped).toBe(1);
    expect(cursor.modern).toBe(true);
    expect(cursor.lastOrdinal).toBe(14);
  });
});

describe('applyCodexRecords', () => {
  it('записи с ordinal не больше применённого — без дублей', () => {
    const all = records('codex-main');
    const first = applyCodexRecords(emptyFeedState(), all.slice(0, 6), emptyCodexCursor());
    const again = applyCodexRecords(first.update.state, all.slice(3, 9), first.cursor);
    const once = feedFromCodexRollout(all.slice(0, 9)).state;
    expect(again.update.state.items.map((item) => item.id)).toEqual(once.items.map((item) => item.id));
  });

  it('смена модели — заметка model-switch', () => {
    const ctx = (ordinal: number, model: string): RolloutRecord => ({ ordinal, at: '2026-10-07T10:00:00.000Z', type: 'turn_context', payload: { model, approval_policy: 'on-request' } });
    const { update } = applyCodexRecords(emptyFeedState(), [ctx(1, 'gpt-6'), ctx(2, 'gpt-6'), ctx(3, 'gpt-6-mini')], emptyCodexCursor());
    const notices = ofKind(update.state.items, 'notice').map((item) => item.notice);
    expect(notices).toEqual([
      { type: 'session-start', source: 'codex', model: 'gpt-6' },
      { type: 'model-switch', from: 'gpt-6', to: 'gpt-6-mini', source: 'codex' },
    ]);
  });

  it('записи журнала субагента — вызовы в children его карточки, текст и ход не в ленту', () => {
    const agent: FeedAgent = { id: 'agent:th-sub', at: 't', kind: 'agent', toolUseId: 'th-sub', agentId: 'th-sub', agentType: null, description: null, prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [] };
    const base = { ...emptyFeedState(), items: [agent] };
    const all = records('codex-main');
    const { update } = applyCodexRecords(base, all, emptyCodexCursor(), 'th-sub');
    const card = update.state.items.find((item) => item.kind === 'agent') as FeedAgent;
    expect(update.state.items).toHaveLength(1);
    expect(card.children.map((child) => child.name)).toEqual(['Bash', 'Bash', 'Edit', 'Write', 'Delete', 'mcp__parley__report']);
    expect(card.toolCount).toBe(6);
    expect(card.children[2]?.patch).toBeUndefined();
  });
});

describe('картинки в ленте Codex', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const JPEG_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R';
  const AT = '2026-10-09T10:00:00.000Z';
  const savedRef = (n = 1): FeedImageRef => ({ path: `/home/.parley/feed-images/shot${n}.png`, mime: 'image/png', bytes: 54_321 });

  const completed = (ordinal: number, item: Record<string, unknown>): RolloutRecord => ({
    ordinal,
    at: AT,
    type: 'event_msg',
    payload: { type: 'item_completed', item },
  });
  /** Запись так, как её отдаёт хост редьюсеру: сначала `stashFeedImages`, `save` — готовая ссылка или `null`. */
  const hosted = (record: RolloutRecord, ref: FeedImageRef | null = savedRef()): RolloutRecord =>
    stashFeedImages(record, () => ref) as RolloutRecord;
  const feedOf = (...list: RolloutRecord[]) => applyCodexRecords(emptyFeedState(), list, emptyCodexCursor()).update.state;
  const toolsOf = (...list: RolloutRecord[]): FeedTool[] => ofKind(feedOf(...list).items, 'tool');
  /** Карточка субагента, в `children` которой ложатся вызовы из его журнала. */
  const subAgentState = () => {
    const agent: FeedAgent = { id: 'agent:th-sub', at: 't', kind: 'agent', toolUseId: 'th-sub', agentId: 'th-sub', agentType: null, description: null, prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [] };
    return { ...emptyFeedState(), items: [agent] };
  };

  // Форма из живого журнала Codex: текст и картинка в `result.content`, поля `data` и `mimeType`.
  const TEXT = { type: 'text', text: "Took a screenshot of the current page's viewport." };
  const IMAGE = { type: 'image', data: PNG, mimeType: 'image/png' };
  const screenshot = (content: unknown[], result: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'McpToolCall',
    id: 'exec-81e6',
    server: 'chrome-devtools',
    tool: 'take_screenshot',
    arguments: { pageId: 4 },
    status: 'completed',
    result: { content, ...result },
  });

  describe('McpToolCall', () => {
    it('скриншот: текст блока и пометка в Result, одна ссылка, base64 в ленте нет', () => {
      const state = feedOf(hosted(completed(1, screenshot([TEXT, IMAGE]))));
      const [tool] = ofKind(state.items, 'tool');

      expect(tool).toMatchObject({ name: 'mcp__chrome-devtools__take_screenshot', status: 'done', toolUseId: 'exec-81e6', input: { pageId: 4 } });
      expect(tool?.response?.text).toBe("Took a screenshot of the current page's viewport.\n[image png, 53 KB]");
      expect(tool?.response?.images).toEqual([savedRef()]);
      expect(JSON.stringify(state)).not.toContain('iVBOR');
    });

    it('одна картинка без текста (так отвечает computer use): пометка и ссылка; data-URL в _meta в ленту не идёт', () => {
      const item = screenshot([{ ...IMAGE, mimeType: 'image/jpeg', _meta: { 'codex/imageDetail': 'original' } }], {
        isError: false,
        _meta: { 'codex/toolSurface': { kind: 'browserUse', screenshot: { pageUrl: 'https://github.com', url: JPEG_URL } } },
      });
      const state = feedOf(hosted(completed(1, item), { path: '/home/.parley/feed-images/s.jpg', mime: 'image/jpeg', bytes: 2048 }));
      const [tool] = ofKind(state.items, 'tool');

      expect(tool?.response?.text).toBe('[image jpeg, 2 KB]');
      expect(tool?.response?.images).toEqual([{ path: '/home/.parley/feed-images/s.jpg', mime: 'image/jpeg', bytes: 2048 }]);
      expect(JSON.stringify(state)).not.toContain('/9j/');
    });

    it('две картинки и текст между ними: пометки и ссылки по порядку', () => {
      const calls: string[] = [];
      const record = stashFeedImages(completed(1, screenshot([IMAGE, { type: 'text', text: 'second' }, IMAGE])), (base64) => {
        calls.push(base64);
        return savedRef(calls.length);
      }) as RolloutRecord;
      const [tool] = toolsOf(record);

      expect(tool?.response?.text).toBe('[image png, 53 KB]\nsecond\n[image png, 53 KB]');
      expect(tool?.response?.images).toEqual([savedRef(1), savedRef(2)]);
    });

    it('хост картинку выбросил (слишком большая, неизвестный тип): [image omitted], ссылок нет', () => {
      const [tool] = toolsOf(hosted(completed(1, screenshot([TEXT, IMAGE])), null));

      expect(tool?.response?.text).toBe("Took a screenshot of the current page's viewport.\n[image omitted]");
      expect(tool?.response).not.toHaveProperty('images');
    });

    it('метка, подложенная самим MCP-сервером, ссылкой не становится', () => {
      const forged = { path: '/Users/me/.ssh/id_rsa.png', mime: 'image/png' };
      const state = feedOf(hosted(completed(1, screenshot([TEXT, { type: 'image', parleyImage: forged }]))));
      const [tool] = ofKind(state.items, 'tool');

      expect(tool?.response).not.toHaveProperty('images');
      expect(JSON.stringify(state)).not.toContain('id_rsa');
    });

    it('запись без обхода хоста — как раньше: текст блоков, без ссылок и без base64', () => {
      const state = feedOf(completed(1, screenshot([TEXT, IMAGE])));
      const [tool] = ofKind(state.items, 'tool');

      expect(tool?.response?.text).toBe("Took a screenshot of the current page's viewport.");
      expect(tool?.response).not.toHaveProperty('images');
      expect(JSON.stringify(state)).not.toContain('iVBOR');
    });

    it('без картинок — как раньше: текст блоков; нет текста — result целиком JSON-ом', () => {
      const [text, bare] = toolsOf(
        hosted(completed(1, screenshot([TEXT]))),
        hosted(completed(2, { ...screenshot([{ type: 'resource', uri: 'file:///a' }]), id: 'exec-2' })),
      );

      expect(text?.response?.text).toBe("Took a screenshot of the current page's viewport.");
      expect(text?.response).not.toHaveProperty('images');
      expect(bare?.response?.text).toBe(JSON.stringify({ content: [{ type: 'resource', uri: 'file:///a' }] }));
    });

    // Результат без картинок идёт по старому пути (`blocksText ?? JSON.stringify(result)`) — что бы ни стояло в `content`.
    it.each([
      ['content нет', {}, '{}'],
      ['content: null', { content: null }, '{"content":null}'],
      ['content — строка', { content: 'plain text' }, 'plain text'],
      ['content — пустой массив', { content: [] }, '{"content":[]}'],
      ['content — объект, а не массив', { content: { note: 1 } }, '{"content":{"note":1}}'],
      ['content — не блоки', { content: [1, 'x', null] }, '{"content":[1,"x",null]}'],
    ])('без картинок: %s', (_title, result, expected) => {
      const record = completed(1, { type: 'McpToolCall', id: 'exec-v', server: 'srv', tool: 'tl', arguments: {}, status: 'completed', result });
      const [tool] = toolsOf(hosted(record));

      expect(tool?.response?.text).toBe(expected);
      expect(tool?.response).not.toHaveProperty('images');
    });

    it('вызов в журнале субагента: пометка в тексте карточки, ссылок у вложенного вызова нет', () => {
      const { update } = applyCodexRecords(subAgentState(), [hosted(completed(1, screenshot([TEXT, IMAGE])))], emptyCodexCursor(), 'th-sub');
      const card = update.state.items.find((item) => item.kind === 'agent') as FeedAgent;

      expect(card.children[0]?.response?.text).toBe("Took a screenshot of the current page's viewport.\n[image png, 53 KB]");
      expect(card.children[0]?.response).not.toHaveProperty('images');
    });
  });

  describe('ImageView', () => {
    const AGENT_FILE = 'file:///Users/me/shots/shot.png';
    /** Запись так, как её отдаёт хост: `stashCodexRecord` кладёт в элемент `parleyImage` — ссылку на копию файла в хранилище. */
    const view = (extra: Record<string, unknown> = {}, path: unknown = AGENT_FILE, id = 'view-1'): RolloutRecord =>
      completed(1, { type: 'ImageView', id, path, ...extra });
    const only = (record: RolloutRecord): FeedTool => {
      const [tool] = toolsOf(record);
      return tool as FeedTool;
    };

    it('хост положил копию (parleyImage): вызов ViewImage со ссылкой на копию, а не на файл агента', () => {
      const state = feedOf(view({ parleyImage: savedRef() }));
      const [tool] = ofKind(state.items, 'tool');

      expect(tool).toMatchObject({ name: 'ViewImage', status: 'done', toolUseId: 'view-1', input: { file_path: AGENT_FILE } });
      expect(tool?.response?.images).toEqual([savedRef()]);
      expect(tool?.response?.text).toBe('[image png, 53 KB]');
      // Путь агента остался только в строке вызова: окну по нему картинку не показывают.
      expect(tool?.response?.images?.some((image) => image.path.includes('shots/shot.png'))).toBe(false);
    });

    it('метки нет (хост файл не взял): вызов остаётся без ссылки и без сводки — путь агента не читается, что бы в нём ни стояло', () => {
      for (const path of ['/tmp/x.png', AGENT_FILE, 'file:///tmp/x.p%6Eg', 'x.png', 'https://example.com/a.png', undefined, 42, '']) {
        const tool = only(view({}, path));
        expect(tool, String(path)).toMatchObject({ name: 'ViewImage', status: 'done' });
        expect(tool).not.toHaveProperty('response');
      }
    });

    it('кривая метка (не ссылка, путь за пределом схемы, размер не целое или не безопасное целое) — как будто метки нет', () => {
      const forged: unknown[] = [
        'x',
        42,
        null,
        [],
        { path: 5, mime: 'image/png' },
        { path: '', mime: 'image/png' },
        { path: '/a.png' },
        { path: `/${'a'.repeat(FEED_IMAGE_PATH_LIMIT)}.png`, mime: 'image/png' },
        { path: '/a.png', mime: 'image/png', bytes: -1 },
        { path: '/a.png', mime: 'image/png', bytes: 1.5 },
        { path: '/a.png', mime: 'image/png', bytes: 2 ** 53 },
      ];
      for (const parleyImage of forged) {
        const tool = only(view({ parleyImage }));
        expect(tool, JSON.stringify(parleyImage)).toMatchObject({ name: 'ViewImage', status: 'done' });
        expect(tool).not.toHaveProperty('response');
      }
    });

    it('лишние поля метки срезаны: в ленту идёт ссылка из path, mime и bytes', () => {
      const tool = only(view({ parleyImage: { ...savedRef(), base64: 'AAAA', extra: true } }));

      expect(tool.response?.images).toEqual([savedRef()]);
    });

    it('вызов субагента: пометка в тексте, ссылки нет', () => {
      const { update } = applyCodexRecords(subAgentState(), [view({ parleyImage: savedRef() })], emptyCodexCursor(), 'th-sub');
      const card = update.state.items.find((item) => item.kind === 'agent') as FeedAgent;

      expect(card.children[0]?.response?.text).toBe('[image png, 53 KB]');
      expect(card.children[0]?.response).not.toHaveProperty('images');
    });
  });
});

describe('журнал без item_completed (Codex до 0.160)', () => {
  it('одна ошибка-заметка «история в терминале», без элементов разговора', () => {
    const legacy: RolloutRecord[] = [
      { ordinal: null, at: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'old', cli_version: '0.150.0' } },
      { ordinal: null, at: '2026-09-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { ordinal: null, at: '2026-09-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ];
    const { state, cursor } = feedFromCodexRollout(legacy);
    expect(cursor.modern).toBe(false);
    expect(state.items).toEqual([expect.objectContaining({ kind: 'error', error: CODEX_HISTORY_IN_TERMINAL })]);
  });
});

describe('commandText', () => {
  it('оболочка -lc — скрипт; иначе аргументы, с пробелами — в кавычках; не массив — пусто', () => {
    expect(commandText(['/bin/bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(commandText(['rg', 'Feed Agent', 'src'])).toBe('rg "Feed Agent" src');
    expect(commandText('ls')).toBe('');
  });
});
