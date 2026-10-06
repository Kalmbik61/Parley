import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EFFORT_TOKEN, PROVIDERS, codexModelsFile, loadProviders, selectableModels } from '@parley/core';
import type { ModelOption } from '@parley/core';
import { EFFORT_TOKEN_RE, METHODS } from '@parley/protocol';
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
  it('каждое значение встроенных списков claude, codex и glm проходит и возвращается как есть', async () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
      for (const { id } of builtInList(entry))
        expect(await resolveModelChoice(entry.id, id)).toEqual({ model: id });
    }
  });

  it('и схема протокола принимает каждое значение списка: окно не предложит того, что схема отвергнет', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
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

  it('GLM принимает 5.3 и Flash из списка, а произвольную модель отклоняет', async () => {
    expect(await resolveModelChoice('glm', 'glm-5.3[1m]')).toEqual({ model: 'glm-5.3[1m]' });
    expect(await resolveModelChoice('glm', 'glm-5.3-flash[1m]')).toEqual({ model: 'glm-5.3-flash[1m]' });

    const refusal = resolveModelChoice('glm', 'что-угодно');
    await expect(refusal).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
    await expect(refusal).rejects.toThrow(/что-угодно.*glm.*glm-5\.3\[1m\].*glm-5\.3-flash\[1m\]/s);
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
    expect(await resolveModelChoice('claude', undefined)).toEqual({});
    expect(await resolveModelChoice('claude', '')).toEqual({});
    expect(await resolveModelChoice('codex', '')).toEqual({});
  });

  it('провайдер без списка — прежнее правило: любое значение проходит; без `{model}` в шаблоне модель отброшена', async () => {
    await writeProviders({
      plain: { badge: 'Plain', command: 'plain', args: ['{prompt}'] },
      smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}'] },
    });
    // Без `{model}` resolver выбор отбрасывает: в карту ложится только то, что дойдёт до команды (как у spawn_session).
    expect(await resolveModelChoice('plain', 'что-угодно')).toEqual({});
    // Свой провайдер с `{model}`, но без списка: значение доедет до команды.
    expect(await resolveModelChoice('smart', 'anything')).toEqual({ model: 'anything' });
  });

  it('неизвестный провайдер не ловится здесь: об этом скажет запуск, как и прежде', async () => {
    expect(await resolveModelChoice('нет-такого', 'opus', 'high')).toEqual({ model: 'opus', effort: 'high' });
  });

  it('свой список из providers.json заменяет встроенный: своё проходит, встроенное — bad_request', async () => {
    await writeProviders({ claude: { models: [{ id: 'my-new-model', label: 'Моя новая' }] } });

    expect(await resolveModelChoice('claude', 'my-new-model')).toEqual({ model: 'my-new-model' });
    await expect(resolveModelChoice('claude', 'opus')).rejects.toMatchObject({
      code: 'bad_request',
    });
    // Соседний провайдер остался при своём списке.
    expect(await resolveModelChoice('codex', 'gpt-6-sol')).toEqual({ model: 'gpt-6-sol' });
  });

  it('пустой список в providers.json снимает проверку: списка у провайдера больше нет', async () => {
    await writeProviders({ claude: { models: [] } });

    expect(await resolveModelChoice('claude', 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5' });
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

    // Выбор до команды всё равно не доедет: resolver его отбрасывает, отказывать нечему.
    expect(await resolveModelChoice('plain', 'b')).toEqual({});
  });
});

describe('resolveModelChoice: effort по уровням модели (спека нормалайзера, 5.3)', () => {
  it('уровень модели — как есть; пустой — без поля; у модели «по умолчанию» — общие уровни провайдера', async () => {
    expect(await resolveModelChoice('claude', 'opus', 'xhigh')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(await resolveModelChoice('claude', 'opus', '')).toEqual({ model: 'opus' });
    expect(await resolveModelChoice('claude', undefined, 'max')).toEqual({ effort: 'max' });
    expect(await resolveModelChoice('glm', 'glm-5.3[1m]', 'max')).toEqual({ model: 'glm-5.3[1m]', effort: 'max' });
    expect(await resolveModelChoice('codex', 'gpt-6.1-sol', 'ultra')).toEqual({ model: 'gpt-6.1-sol', effort: 'ultra' });
  });

  it('уровня нет у модели — bad_request с причиной и списком допустимого', async () => {
    await expect(resolveModelChoice('claude', 'haiku', 'high')).rejects.toMatchObject({
      name: 'HostError',
      code: 'bad_request',
    });
    await expect(resolveModelChoice('claude', 'haiku', 'high')).rejects.toThrow(/haiku has no effort levels/);
    await expect(resolveModelChoice('claude', 'opus', 'ultra')).rejects.toThrow(
      /ultra is not a level of opus; allowed: low, medium, high, xhigh, max/,
    );
    await expect(resolveModelChoice('codex', 'gpt-6-luna', 'ultra')).rejects.toThrow(/ultra is not a level of gpt-6-luna/);
    // «По умолчанию» у Codex — общие уровни видимых моделей, а `ultra` есть не у всех.
    await expect(resolveModelChoice('codex', undefined, 'ultra')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('провайдер без {effort} в шаблоне отбрасывает уровень молча, как и прежде', async () => {
    await writeProviders({ smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}'] } });

    expect(await resolveModelChoice('smart', 'anything', 'high')).toEqual({ model: 'anything' });
  });

  it('каталог Codex из файла хоста: модель и уровни из него, а свой список из providers.json важнее', async () => {
    const live: ModelOption[] = [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: [{ id: 'ultra', label: 'Ultra' }] }];
    // Без файла — встроенный список, а модели из каталога в нём нет.
    await expect(resolveModelChoice('codex', 'gpt-7-nova', 'ultra')).rejects.toMatchObject({ code: 'bad_request' });

    await writeFile(codexModelsFile(), JSON.stringify({ fetchedAt: '2026-10-06T10:00:00.000Z', models: live }), 'utf8');
    expect(await resolveModelChoice('codex', 'gpt-7-nova', 'ultra')).toEqual({ model: 'gpt-7-nova', effort: 'ultra' });
    // Каталог Codex другим провайдерам не достаётся.
    await expect(resolveModelChoice('claude', 'gpt-7-nova')).rejects.toMatchObject({ code: 'bad_request' });

    await writeProviders({ codex: { models: [{ id: 'mine', label: 'Моя' }] } });
    expect(await resolveModelChoice('codex', 'mine')).toEqual({ model: 'mine' });
    await expect(resolveModelChoice('codex', 'gpt-7-nova')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('токен уровня один в core и в протоколе: EFFORT_TOKEN и EFFORT_TOKEN_RE с одним исходником', () => {
    expect(EFFORT_TOKEN_RE.source).toBe(EFFORT_TOKEN.source);
    expect(EFFORT_TOKEN_RE.flags).toBe(EFFORT_TOKEN.flags);
    // Схема sessions.create принимает effort ровно тогда, когда его примет core (схемы смены — с Task 10).
    const create = { projectPath: '/p', workId: 'w-0001', provider: 'claude', label: '', task: '', parent: null };
    const samples = ['low', 'xhigh', 'ultra', 'max_2', 'a-b', 'a', 'a'.repeat(32), 'a'.repeat(33), 'High', '1low', '-low', 'x"y', 'x y', 'low\n', ''];
    for (const effort of samples) {
      const schemaAccepts = METHODS['sessions.create'].safeParse({ ...create, effort }).success;
      expect(schemaAccepts, JSON.stringify(effort)).toBe(EFFORT_TOKEN.test(effort));
    }
  });
});
