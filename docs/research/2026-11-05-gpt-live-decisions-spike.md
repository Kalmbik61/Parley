# V0: Decisions GPT-Live для эмоции голосового острова

- **Дата:** 2026-11-05. Задача V0 принятого решения p-45, комната r-22; исполнитель s-274, ревью s-257.
- **База:** `feat/voice-assistant-modules`, `73171b797eb0985e565b346d47834354dcb164d3`.
- **Вывод:** на текущем ключе `gpt-live-1` принимает output Decisions trigger при создании и через `session.update`. Эмоции доступны непосредственно клиенту WebRTC; дополнительный запрос с острова не нужен.
- Код продукта не менялся. **Одна Live-сессия, 41 финальная billed second из лимита 90; `session.closed`, `reason: close_requested` получены на обоих каналах.**

## 1. Метод и границы проверки

Прочитаны T0 (`docs/research/2026-11-04-gpt-live-transport-spike.md`), T7 (`docs/audits/2026-11-04-voice-assistant-acceptance.md`), `voice-prompt.ts`, `live-client.ts` и сервис подготовки голосовой сессии. Харнесс `/tmp/s274-decisions/` повторяет транспорт T0: серверный `POST /v1/live/sessions`, WebRTC `oai-events`, серверный sideband `/v1/live/sessions/{id}/attach`. Ключ прочитан только серверным процессом через существующий `readSecret('voice:openai')`; ключ не передавался странице, не выводился и не сохранялся в evidence. Ответ страницы содержит только SDP и id сессии. Здесь сервис хоста не запускался, поэтому `voice_usage` продукта не пополнялся.

Использован готовый `liveSessionConfig()` из сборки T7 s-273; исходный `voice-prompt.ts` побайтно совпадает с базой. Добавлен только `triggers`; настройки и промпт Parley сохранены. Сервер — Node 22, WebSocket с заголовком Authorization — установленный Undici 8.11.2. Первый запуск на Bun завершился из-за отсутствия `node:sqlite` до сетевых вызовов. `PARLEY_SESSION_ID` и `HARNAS_SESSION_ID` удалены из окружения. `pnpm dev`, Electron и чужие хосты не запускались.

В Parley browser открыта страница харнесса. Синтетический человек: macOS `say`, Samantha, 195 слов/мин → WAV mono 48 кГц → WebAudio → `MediaStreamDestination` → микрофонный трек WebRTC. Три последовательные просьбы сыграть счастливую, грустную и удивлённую фразу; между ними 9 с после конца WAV. Модель действительно произнесла короткие фразы соответствующего содержания. Для сервера установлен автоматический `session.close` через 62 с; сценарий сам закрыл сессию раньше. От начала HTTP-запроса до получения финала — 48,767 с настенных часов; это не billed seconds.

Артефакты вне репозитория: `server.mjs`, `client.js`, `index.html`, WAV, `evidence.json`, `analyze.py`, `analysis.json`. Аудиоданные sideband в evidence не сохранялись; транскрипты в локальном scratch нужны для сверки, ниже текст удалён. SHA-256 `evidence.json`: `b7ef5052fa8ddb01349c7397285bd8968ee22d474542643bde77f49ab00a339b`.

## 2. Рабочая конфигурация и update

**Измерено:** HTTP **201** для тела `{ "session": <JSON ниже>, "transport": { "type": "webrtc", "sdp": "<offer>" } }`. Ответ: `{session:{id},transport:{type,sdp}}`. Никаких alpha-заголовков не добавлялось. Делегация остаётся `client`; `model` внутри trigger не задаётся.

```json
{
  "model": "gpt-live-1",
  "instructions": "You are Parley's voice assistant, a calm, friendly voice companion. Speak briefly, at most two sentences.\nBackchannel policy: Use minimal backchannels.\nInterruption policy: Stop speaking when the user interrupts. Listen to what they say.\nDelegation policy:\nBackend tools:\n- Parley assistant: knows the state of Parley rooms, sessions, background jobs, works and builds, and can prepare actions for the user to confirm on screen.\nGenerate <|SpawnThinking|> when:\n- The user asks about the state of rooms, sessions, jobs, works, builds or anything else in Parley.\n- The user asks to create or change something in Parley.\n- A correction changes work already requested.\nDo not generate <|SpawnThinking|> when:\n- The user greets you or makes small talk.\n- You can answer from the conversation or a still-current result.\n- You need a brief clarification.\nGenerate <|SpawnThinking|> before giving an answer that depends on backend work.\nDo not guess the result while waiting. After you hand off work, give exactly one very short spoken acknowledgment, then keep chatting normally.\nWhen a result arrives, recap it briefly, tie it to the question it answers, and say how old the snapshot is.\nNever speak identifiers, ids, hashes or long numbers; use names instead.\nWhen the result says an action was prepared, say that you prepared a card and the user should confirm it on the screen. Never say an action was done before the user confirms.\nSpeak in the language the user speaks.",
  "delegation": {
    "type": "client"
  },
  "triggers": [
    {
      "type": "decisions",
      "event_type": "session.output_transcript.delta",
      "decisions": {
        "questions": [
          {
            "type": "choice",
            "name": "expression",
            "instructions": "Pick the emotion of what the assistant is saying right now.",
            "choices": [
              {
                "value": "calm"
              },
              {
                "value": "joy"
              },
              {
                "value": "sad"
              },
              {
                "value": "surprise"
              },
              {
                "value": "anger"
              }
            ]
          }
        ]
      }
    }
  ]
}
```

Сразу после attach, до синтетической речи, отправлено следующее. **Измерено:** принят `session.updated` с `client_event_id: "v0_update_trigger"` и тем же `session.triggers`; событие пришло на оба канала. Ошибок конфигурации и других `error` не получено. HTTP при создании и update подтверждены отдельно, но речевые результаты измерены уже после update; отдельная речь только с первоначальной конфигурацией не измерялась.

```json
{
  "type": "session.update",
  "event_id": "v0_update_trigger",
  "session": {
    "triggers": [
      {
        "type": "decisions",
        "event_type": "session.output_transcript.delta",
        "decisions": {
          "questions": [
            {
              "type": "choice",
              "name": "expression",
              "instructions": "Pick the emotion of what the assistant is saying right now.",
              "choices": [
                {
                  "value": "calm"
                },
                {
                  "value": "joy"
                },
                {
                  "value": "sad"
                },
                {
                  "value": "surprise"
                },
                {
                  "value": "anger"
                }
              ]
            }
          ]
        }
      }
    ]
  }
}
```

По [Decisions voice guide](https://developers.openai.com/api/docs/guides/decisions-voice) вопросы можно обновлять во время сессии. [Общий Live guide](https://developers.openai.com/api/docs/guides/live-conversations) всё ещё ограничивает update настройками Responses и не перечисляет triggers. Реальный ответ здесь разрешил это противоречие в пользу Decisions guide; старое ограничение Azure не описывает измеренную версию OpenAI.

## 3. Полная форма события и канал доставки

**Измерено:** 22 уникальных `decision.event` на WebRTC data channel и те же 22 на sideband, с одинаковыми `event_id` и содержимым. Фильтры событий не задавались. Вот одно целое событие без сокращения полей:

```json
{
  "event_id": "event_EglMw70ZSJ5OMyrf2J0R6",
  "type": "decision.event",
  "delegation_id": null,
  "event": {
    "type": "decision.completed",
    "decision": {
      "model": "gpt-6-luna",
      "answers": [
        {
          "type": "choice",
          "name": "expression",
          "choice": "joy",
          "probabilities": [
            {
              "value": "calm",
              "probability": 0.02
            },
            {
              "value": "joy",
              "probability": 0.98
            },
            {
              "value": "sad",
              "probability": 0
            },
            {
              "value": "surprise",
              "probability": 0
            },
            {
              "value": "anger",
              "probability": 0
            }
          ],
          "confidence": 0.98
        }
      ],
      "usage": {
        "input_tokens": 165,
        "input_tokens_details": {
          "cached_tokens": 0,
          "cache_write_tokens": 0
        },
        "output_tokens": 0,
        "output_tokens_details": {
          "reasoning_tokens": 0
        },
        "total_tokens": 165
      }
    }
  },
  "source_event_id": "event_EglMwXrcElK0HEaTEwiko",
  "source_event_type": "session.output_transcript.delta",
  "trigger_id": "trg_EglMwv29MKYZrth8dZVml"
}
```

Связанный исходный фрагмент (изменён только текст):

```json
{
  "type": "session.output_transcript.delta",
  "start_ms": 5800,
  "end_ms": 6000,
  "delta": "[текст удалён]",
  "event_id": "event_EglMwXrcElK0HEaTEwiko"
}
```

В самом `decision.event` **нет offsets**: `start_ms`/`end_ms` берутся из фрагмента по `source_event_id`. `delegation_id` равен `null`; это независимый transcript trigger. `trigger_id` присутствует, но в этом прогоне все **22 значения были различными**, хотя настроен один trigger: использовать его как постоянный id подписки нельзя. Для объединения двух каналов подходит внешний `event_id`, для привязки к речи — `source_event_id` + `source_event_type`. Вложенный `event.decision` содержит модель, ответы с вероятностями/confidence и отдельный token usage; отдельного decision id в измеренном событии нет.

## 4. Частота, задержка и смысл эмоций

| Показатель | Результат | Статус |
|---|---|---|
| Output deltas / решения | 22 / 22; каждый source id связан ровно с одним решением | measured |
| Слияние нескольких deltas / перестановка решений | не наблюдались; порядок source offsets возрастающий | measured для одного прогона |
| Серверный debounce | признаков нет: решение на каждый полученный delta, в том числе с разницей offsets 200 мс | measured для одного прогона |
| Задержка delta → decision на sideband, n=22 | min 1 мс; median 154,5 мс; p95 496 мс; max 661 мс | measured; p95 — nearest rank |
| Точная задержка на WebRTC | not measured: клиент отправлял события серверу пачками раз в 200 мс | not measured |
| От произнесённого звука до эмоции на лице | not measured: звук и анимация острова не инструментированы | not measured |
| Частота за минуту разговора | 22 × 60 / 41 = 32,20 решения/мин | оценка по measured billed seconds, с паузами |

Задержка измерена разностью `Date.now()` в одном Node-процессе при получении двух sideband-событий. Это задержка доставки между событиями, включая сеть, а не время вычисления Decisions и не задержка относительно воспроизведения. Значение 1 мс возможно при совместной доставке уже готовых событий. Пачки WebRTC для этой статистики не использованы.

| Синтетическая просьба | Диапазон output offsets | Выбор по deltas | Статус |
|---|---|---|---|
| Счастливая фраза о выигрыше | 5400–7800 мс | calm ×2, затем joy ×4 | measured |
| Грустная фраза о потере друга | 18200–21400 мс | sad ×10 | measured |
| Удивлённая фраза о говорящем коте | 32400–34600 мс | surprise ×6 | measured |
| anger | сценария не было | not measured | not measured |

Начальные короткие фрагменты счастливой фразы ещё дали calm (confidence 0,41 и 0,64); после смыслового слова появился joy (0,98). Следовательно, корректность полных фраз подтверждена в трёх примерах, а безошибочная классификация каждого обрывка не подтверждена. Общая точность и устойчивость к смешанным эмоциям — not measured. [Официальный guide](https://developers.openai.com/api/docs/guides/decisions-voice) допускает объединение pending deltas и ответы вне порядка; отсутствие этих случаев здесь не отменяет обработку устаревших результатов.

## 5. Usage и стоимость

Пример полного `session.usage.updated`:

```json
{
  "type": "session.usage.updated",
  "usage": {
    "seconds": 15
  },
  "context_window": {
    "usage_ratio": 0.01090625
  },
  "event_id": "event_EglN0Rk2niCM8jm2xglME"
}
```

**Измерено:** накопленные `usage.seconds`: **15 → 25 → 40**, затем финальный `session.closed.usage.seconds: 41`. `session.usage.updated` содержит секунды и заполнение context window, **не стоимость и не Decisions-токены**. Эти обновления нельзя суммировать. Финальный учёт берётся из `session.closed`.

**Измерено отдельно:** сумма `event.decision.usage` после дедупликации по event id — **4703 input tokens**, **0 cached tokens**, **0 cache-write tokens**, **0 output tokens**, 22 решения. На один запрос от 162 до 267 input tokens; повторный контекст увеличивает их число. Дубликаты sideband/WebRTC второй раз не учитывались.

По [Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability), стандартный тариф — 0,10 USD за миллион uncached input tokens, output не тарифицируется; cache имеет отдельные ставки. По [Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1), Live — 0,05 USD/мин, backend отдельно.

| Показатель | Значение | Статус |
|---|---|---|
| Финальный расход Live | **41 с**, 1 закрытая сессия; лимит 90 с соблюдён | measured API usage |
| Decisions | 4703 × 0,10 / 1 000 000 = **0,0004703 USD** | оценка по measured tokens и опубликованному тарифу |
| Live | 41 / 60 × 0,05 = **0,0341667 USD** | оценка по measured seconds и опубликованному тарифу |
| Всего | **≈0,034637 USD** | оценка, не сверка счёта |
| За минуту разговора при частоте этого прогона | Decisions **≈0,000688 USD/мин**, Live **0,05 USD/мин**, всего **≈0,050688 USD/мин** | оценка: нормировка на 41 billed second, включая паузы |
| За минуту непрерывной речи ассистента | not measured: нет замера фактического активного аудио; transcript spans не заменяют его | not measured |
| Отдельная строка Decisions в счёте OpenAI, региональные надбавки/скидки | счёт и настройки биллинга не запрашивались | not measured |

Оценка цены за минуту относится к короткому разговору. Она не доказывает цену длинной сессии: история и cache могут изменить стоимость Decisions. Организационный usage endpoint требует admin key; ради этого спайка такой ключ не искался.

## 6. Есть ли эмоция в самом транскрипте

**Измерено:** все 22 output deltas имеют только `type`, `start_ms`, `end_ms`, `delta`, `event_id`. Полей emotion/expression, вероятностей или интенсивности в них нет; специальных emotion-тегов в тексте трёх фраз не встретилось. Смысл слов позволяет человеку понять эмоцию, но готового машинного сигнала для лица транскрипт не содержит. Отдельная контрольная сессия без triggers не запускалась (not measured); вывод относится к форме output transcript в этом прогоне и согласуется с T0.

## 7. Рекомендация острову

Клиенту подписываться на `decision.event` **и** `session.output_transcript.delta`; если появится фильтр WebRTC, разрешать оба типа. Для `event.type === "decision.completed"` читать `event.decision.answers` по `name === "expression"`, принимать только calm/joy/sad/surprise/anger. Sideband для показа лица не требуется. При использовании обоих каналов дедуплицировать внешний `event_id`; source delta хранить по id, чтобы получить его offsets. Не выбирать делегацию `decisions` вместо существующей `client`: transcript trigger работает независимо.

Предлагаемое, **не измеренное в UI**, сглаживание: одинаковое значение не перезапускает анимацию; каждую новую эмоцию держать не менее **1,5 с**, пока модель говорит. В течение этого времени оставлять последним кандидатом решение с самым новым исходным `end_ms`, затем применять его, если речь ещё продолжается. Устаревший source offset не должен откатывать лицо; `trigger_id` для порядка не подходит. Завершение речи/переход в слушание определять существующим аудиосигналом, рот вести по аудио. При отсутствии корректного решения — calm и отметка в телеметрии. Выбор 1,5 с соответствует p-45, но визуально здесь не проверялся.

## Не проверено

Настоящий микрофон, русская речь, шум, субъективное звучание, лицо/рот острова и debounce в UI; anger и смешанные эмоции; input trigger; удаление/изменение вопроса вместо повторного задания того же trigger через update; речь до update; фильтрация WebRTC; длинная сессия, cache, региональная тарификация и счёт OpenAI. Продуктовые тесты не запускались: изменена только исследовательская записка. Ключ, модель и Decisions ничем не подменялись.

## Карточка влияния

- Goal: проверить доступность Decisions для эмоции острова и зафиксировать wire contract.
- Behaviour: реальный OpenAI принял создание и update с output trigger; результаты приходят клиенту и sideband, happy/sad/surprise различаются. Код продукта не менялся.
- Numbers: measured — 1 сессия, 41 billed second, 22 deltas/22 решения, 4703 input tokens, median 154,5 мс, p95 496 мс. Общая точность — not measured, выборка из трёх фраз.
- Screens: not measured — продуктовый UI не проверялся; использована служебная страница Parley browser.
- For the human: рабочая конфигурация, полный event JSON и рекомендация подписки/удержания 1,5 с; дополнительные действия в продукте не выполнялись.
- Risk: частичный текст сначала может дать calm; порядок/слияние и ошибки требуют защиты; длинный разговор и визуальная устойчивость — not measured.
- Cost: оценка ≈0,034637 USD, из неё Decisions ≈0,0004703 USD; счёт OpenAI и стоимость CLI — not measured.
- Verdict: PASS V0 для текущего ключа и модели; готовность продуктовой анимации — not measured.
