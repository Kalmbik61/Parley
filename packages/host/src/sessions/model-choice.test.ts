import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS, loadProviders, selectableModels } from '@parley/core';
import { METHODS } from '@parley/protocol';
import { resolveModelChoice } from './model-choice.js';

let home = '';
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-model-choice-'));
  savedHome = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = savedHome;
  await rm(home, { recursive: true, force: true });
});

const writeProviders = (data: unknown): Promise<void> =>
  writeFile(path.join(home, 'providers.json'), JSON.stringify(data), 'utf8');

/** Список встроенного провайдера; его отсутствие — провал, а не пустой обход, что прошёл бы впустую. */
function builtInList(entry: typeof PROVIDERS.claude): Array<{ id: string; label: string }> {
  const list = selectableModels(entry);
  if (list === null) throw new Error(`у ${entry.id} нет списка моделей`);
  return list;
}

describe('resolveModelChoice: модель из диалога запуска против списка провайдера', () => {
  it('каждое значение встроенных списков claude и codex проходит и возвращается как есть', async () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
      for (const { id } of builtInList(entry))
        expect(await resolveModelChoice(entry.id, id)).toBe(id);
    }
  });

  it('и схема протокола принимает каждое значение списка: окно не предложит того, что схема отвергнет', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
      for (const { id } of builtInList(entry)) {
        const parsed = METHODS['sessions.create'].safeParse({
          projectPath: '/p',
          workId: 'w-0001',
          provider: entry.id,
          label: '',
          task: '',
          parent: null,
          model: id,
        });
        expect(parsed.success, `${entry.id}: ${id}`).toBe(true);
      }
    }
  });

  it('providers.json принимает в id ровно то, что примет схема sessions.create: список не пропустит значение, на котором create упадёт', async () => {
    const schemaAccepts = (model: string): boolean =>
      METHODS['sessions.create'].safeParse({
        projectPath: '/p',
        workId: 'w-0001',
        provider: 'claude',
        label: '',
        task: '',
        parent: null,
        model,
      }).success;
    // Пустое значение схема принимает как «по умолчанию»; в списке его нет, поэтому среди образцов его тоже нет.
    const samples = [
      'opus',
      'sonnet[1m]',
      'gpt-6.1-sol',
      'a-b',
      'ключ',
      'x'.repeat(200),
      'x'.repeat(201),
      ' opus',
      'op us',
      'op\tus',
      '-opus',
      '--model',
    ];

    for (const id of samples) {
      await writeProviders({ claude: { models: [{ id, label: 'Х' }] } });
      const loads = await loadProviders().then(
        () => true,
        () => false,
      );
      expect(loads, JSON.stringify(id)).toBe(schemaAccepts(id));
    }
  });

  it('модель не из списка — bad_request; в сообщении провайдер, модель и допустимые значения', async () => {
    const refusal = resolveModelChoice('claude', 'gpt-6-sol');

    await expect(refusal).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
    await expect(refusal).rejects.toThrow(/gpt-6-sol.*claude.*opusplan/s);
    // Значение чужого провайдера и слегка иное написание — тоже не из списка: сверка точная.
    await expect(resolveModelChoice('codex', 'opus')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(resolveModelChoice('claude', 'Opus')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(resolveModelChoice('claude', 'claude-opus-5-5')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('пустая модель и её отсутствие — «по умолчанию»: без флага, даже у провайдера со списком', async () => {
    expect(await resolveModelChoice('claude', undefined)).toBeUndefined();
    expect(await resolveModelChoice('claude', '')).toBeUndefined();
    expect(await resolveModelChoice('codex', '')).toBeUndefined();
  });

  it('провайдер без списка — прежнее правило: любое значение проходит', async () => {
    // У glm нет ни списка, ни `{model}` в шаблоне: выбор отбрасывает сам шаблон.
    expect(await resolveModelChoice('glm', 'что-угодно')).toBe('что-угодно');
    // Свой провайдер с `{model}`, но без списка: значение доедет до команды.
    await writeProviders({ smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}'] } });
    expect(await resolveModelChoice('smart', 'anything')).toBe('anything');
  });

  it('неизвестный провайдер не ловится здесь: об этом скажет запуск, как и прежде', async () => {
    expect(await resolveModelChoice('нет-такого', 'opus')).toBe('opus');
  });

  it('свой список из providers.json заменяет встроенный: своё проходит, встроенное — bad_request', async () => {
    await writeProviders({ claude: { models: [{ id: 'my-new-model', label: 'Моя новая' }] } });

    expect(await resolveModelChoice('claude', 'my-new-model')).toBe('my-new-model');
    await expect(resolveModelChoice('claude', 'opus')).rejects.toMatchObject({
      code: 'bad_request',
    });
    // Соседний провайдер остался при своём списке.
    expect(await resolveModelChoice('codex', 'gpt-6-sol')).toBe('gpt-6-sol');
  });

  it('пустой список в providers.json снимает проверку: списка у провайдера больше нет', async () => {
    await writeProviders({ claude: { models: [] } });

    expect(await resolveModelChoice('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('список у провайдера, чей шаблон не принимает {model}, окну не отдаётся — значит, и не проверяется', async () => {
    await writeProviders({
      plain: {
        badge: 'Plain',
        command: 'plain',
        args: ['{prompt}'],
        models: [{ id: 'a', label: 'А' }],
      },
    });

    // Выбор до команды всё равно не доедет: его отбросит шаблон, отказывать нечему.
    expect(await resolveModelChoice('plain', 'b')).toBe('b');
  });
});
