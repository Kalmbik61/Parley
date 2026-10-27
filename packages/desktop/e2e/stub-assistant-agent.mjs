#!/usr/bin/env node
// Заглушка `claude` для E2E помощника: ход помощника (`--strict-mcp-config`) зовёт инструменты через маршрут хоста
// и печатает stream-json; любой другой запуск (сессии работы) уходит в stub-echo-agent.mjs.
// `--version` отвечает сама: заглушка агента говорит 2.1.286, а помощнику нужен claude не старше 2.1.300.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.300 (Claude Code)\n');
  process.exit(0);
} else if (!args.includes('--strict-mcp-config')) {
  const echo = fileURLToPath(new URL('./stub-echo-agent.mjs', import.meta.url));
  const child = spawn(process.execPath, [echo, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Строки `[system: …]` перед вопросом (смена голоса, исход карточки) — от Parley: снимаются все, строка о смене
  // голоса запоминается — «voice check» возвращает её в ответе (G1).
  let prompt = args[args.indexOf('-p') + 1] ?? '';
  const notes = [];
  const systemLine = /^\[system:[^\]]*\]\n/;
  for (let line = systemLine.exec(prompt); line !== null; line = systemLine.exec(prompt)) {
    notes.push(line[0].trim());
    prompt = prompt.slice(line[0].length);
  }
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  const { PARLEY_ASSISTANT_URL: url, PARLEY_ASSISTANT_TOKEN: token } = Object.values(config.mcpServers)[0].env;
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const call = async (tool, body) => {
    const response = await globalThis.fetch(`${url}/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  out({ type: 'system', subtype: 'init', session_id: 'stub-assistant-1' });
  // «slow …» — ход думает 2 с: за это время окно копит очередь.
  if (/^slow /i.test(prompt)) await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__parley-assistant__parley_overview', input: {} }] } });
  const overview = await call('parley_overview', {});
  const room = /\[(room:[^\]]+)\]/.exec(overview.text ?? '')?.[1];
  const session = /\[(session:[^\]]+)\]/.exec(overview.text ?? '')?.[1];
  const work = /\[(work:[^\]]+)\]/.exec(overview.text ?? '')?.[1];
  let answer = '[[calm]] Nothing is open right now.';
  /** Пауза между словами ответа, мс: «moods …» идёт словами долго, чтобы фаза ответа была видна. */
  let wordDelay = 0;
  // «long …» — тот же ход, но к ответу дописаны 40 строк: проверка, что длинный обмен не выходит за кадр острова.
  const long = /^long /i.test(prompt);
  const ask = long ? prompt.slice('long '.length) : prompt;
  const createRoom = /^create room (.+)$/i.exec(ask);
  if (createRoom !== null && work !== undefined && session !== undefined) {
    // Комната: работа и сессия берутся из обзора, название — из вопроса.
    const input = { work, title: createRoom[1], members: [session], task: 'Start with tests.' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley-assistant__propose_room', input }] } });
    await call('propose_room', input);
    answer = '[[calm]] Prepared a room card.';
  } else if (/^check in 2 seconds/i.test(ask)) {
    // Напоминание через 2 с: ход по напоминанию придёт промптом `[reminder …]`.
    const input = { at: new Date(Date.now() + 2000).toISOString(), what: 'the room' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley-assistant__schedule_check', input }] } });
    await call('schedule_check', input);
    answer = '[[calm]] I will check in 2 seconds.';
  } else if (ask.startsWith('[reminder')) {
    answer = '[[joy]] Reminder: the room is fine.';
  } else if (/^echo /i.test(ask)) {
    // Вопрос как пришёл: очередь окна уходит одним ходом, сообщения через пустую строку.
    answer = `[[calm]] Got: ${ask.split('\n\n').join(' | ')}`;
  } else if (/^mention /i.test(ask) && room !== undefined && session !== undefined) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley-assistant__propose_message', input: { target: room, text: 'Skip the Safari tests.', mention: [session] } }] } });
    await call('propose_message', { target: room, text: 'Skip the Safari tests.', mention: [session] });
    answer = '[[calm]] I prepared a message for the planner in the room.';
  } else if (/^tell /i.test(ask) && room !== undefined) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley-assistant__propose_message', input: { target: room, text: 'Skip the Safari tests.' } }] } });
    await call('propose_message', { target: room, text: 'Skip the Safari tests.' });
    answer = '[[calm]] I prepared a message for the room.';
  } else if (/^moods /i.test(ask)) {
    // Метка эмоции в каждом предложении (#9 §6.7 L3): лицо меняет эмоцию между предложениями.
    answer = '[[joy]] The room is working well today. [[sad]] One test failed in the last run. [[surprise]] Did you expect that result?';
    wordDelay = 40;
  } else if (/^speak long/i.test(ask)) {
    // Долгая речь: 24 предложения с метками — лицо говорит несколько секунд (V1–V3, хоткей и Esc во время речи).
    answer = Array.from({ length: 24 }, (_, i) => `[[${i % 2 === 0 ? 'calm' : 'joy'}]] Sentence number ${i + 1} is spoken now.`).join(' ');
  } else if (/^voice check/i.test(ask)) {
    // G1: какая строка о смене голоса пришла с вопросом.
    const note = notes.find((line) => line.startsWith('[system: voice changed'));
    answer = `[[calm]] Voice note: ${note ?? 'none'}.`;
  } else if (room !== undefined) {
    answer = '[[joy]] The room is working.';
  }
  if (long) answer += Array.from({ length: 40 }, (_, i) => `\nDetail ${i + 1}.`).join('');
  for (const word of answer.split(/(?<= )/)) {
    if (wordDelay > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, wordDelay));
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: 'stub-assistant-1' });
}
