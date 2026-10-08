# P01 — Claude CLI: источники, budget, jev, роли и lifecycle

Дата: 2026-10-03. Рабочая база: `codex/parley-upgrade`, `c1d4bb4`. Только исследование; продуктовые файлы, глобальные настройки и оригинал jev не изменялись. Запись результата принадлежит P01; очередь ведёт root.

## Решение для P04

**Сохранить полный родной список по умолчанию и включать базовый `find_skill` поверх него.** Env-сокращение технически работает в наблюдаемой версии, но полный production gate не пройден: synced/account/policy resolver, интерактивный statusLine и настоящий host report/wake требуют отдельной проверки P32. Ни один из этих пунктов не объявляется успешным по синтетическому транспорту.

Обязательное исправление спеки: `skillListingBudgetFraction: 0` **не является рабочей настройкой** в 2.1.287. Schema требует `>0 && <=1`; print запуск с нулём завершается успешно и молча возвращает полный список. `SLASH_COMMAND_TOOL_CHAR_BUDGET=1` — подтверждённый кандидат, только после остальных gates.

| Механизм | Наблюдаемое доказательство | Безопасный путь / оставшаяся проверка |
|---|---|---|
| User/project/commands/plugin | Native `skill_listing.names` сопоставлен с fixtures; commands входят, user выигрывает project-коллизию | Общий resolver обязан включить команды и реальные имена CLI, не только SKILL.md |
| Скрытия | `disable-model-invocation`, `off`, `user-invocable-only` отсутствуют в model attachment; `name-only` остаётся именем | Панель хранит установленное; navigator исключает скрытое до ranking; menu/init.skills не равно model listing |
| Env budget=1 | Семь небандлённых имён сохранены, descriptions отсутствуют; исключение bundled сохраняет description | Не обещать жёсткий лимит в 1 символ; это бюджет descriptions, не полный размер списка |
| Settings fraction=0 | Exit 0; payload и listing как baseline; source schema `gt(0)` | Удалить этот вариант из спеки; не включать по exit 0 |
| Skill загрузка | Синтетический model tool-use заставил реальный CLI загрузить `project-only`; следующий API payload содержит BODY fixture | Это проверка loader/protocol, не качества решения модели |
| Jev session-only | Контроль enabled: classifier + main request, listing withheld; disabled exact plugin id: один main request, listing restored | Проверять обнаруженный id; неизвестную установку не гасить через all-hooks/safe-mode/bare |
| Main native role | `--agent main` даёт whitelist `Skill`, `mcp__parley__find_skill`, `mcp__parley__report`, API `Agent` | У неизвестной/урезанной роли не сокращать список и не обещать отсутствующий инструмент |
| CLI subagent | API payload child: только `Skill` и `mcp__parley__find_skill`; реальный loader вызван, MCP fixture получил запрос | Не доказана доступность MCP у каждой пользовательской роли или её permission policy |
| Synced | Созданный account fixture в `skills/synced/` не попал в listing | Не считать любой файл под synced доступным. Нужен account/manifest/config gate; unsupported → diagnostics + native full list |
| Command hooks | Enabled/disabled jev обе пары: SessionStart, UserPromptSubmit, Stop, SessionEnd записаны | Notification/PermissionRequest/HTTP hooks/channel delivery требуют настоящего host сценария |
| StatusLine | `--settings` содержит его, но marker не создан в print-mode | Интерактивный TUI probe в P32; наличие JSON не доказательство исполнения |
| Report/wake | MCP stub рекламирует report; host не запускается | Настоящий `report(done)`/turn-end/wake не проверен. Native ScheduleWakeup не подмена будильника Parley |

## Метод и границы доказательств

CLI: `/Users/kalmbik61/.local/bin/claude` → `~/.local/share/claude/versions/2.1.287`, Mach-O arm64, `2.1.287 (Claude Code)`; SHA-256 `6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea`.

Временная область: `/tmp/parley-p01-claude` (CLI canonical cwd `/private/tmp/parley-p01-claude/project`). `HOME` и `CLAUDE_CONFIG_DIR` указывают только сюда. Все `CLAUDE*`, `ANTHROPIC*`, `PARLEY*`, `HARNAS*` переменные исходного окружения отфильтрованы; передан dummy API key, `ANTHROPIC_BASE_URL=http://127.0.0.1:<ephemeral-port>`, nonessential traffic/autoupdate выключены. Credentials не копировались и не печатались. Оригинал jev только читался; для контрольной пары скопирована его папка в fixture config.

Локальный HTTP сервер принимает native CLI запросы и возвращает синтетические Anthropic SSE messages/tool-use; stdio MCP — fixture, не настоящий Parley. Это запуск настоящего CLI/parser/loader/module/hooks/subagent runner с подменённой моделью, **не реальная inference-сессия**. Внешних model requests не было. Первоначальная попытка bind loopback в sandbox получила `PermissionError: Operation not permitted`; запуск изолированного сервера прошёл через разрешённый `require_escalated`.

Основной argv (каждый параметр отдельный элемент массива, без shell eval):

```text
claude -p "Reply OK." --model haiku --output-format stream-json --verbose
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --plugin-dir /tmp/parley-p01-claude/plugin
  --settings /tmp/parley-p01-claude/session.json
  --debug-file /tmp/parley-p01-claude/<probe>.debug
```

Advanced использует тот же argv с MCP `parley={command:python3,args:[.../mcp.py]}` и описанными ниже добавлениями. Все процессы bounded timeout 25 s, exit 0 в завершённых probes. Одновременно внешние CLI сессии не запускались.

## Fixture и родной список

Локальные `name:` намеренно отличаются от имени папки (`decorative-<directory>`). В этой версии native имя простого user/project skill взято из **папки**, не из такого frontmatter. Plugin имя — `fixture:plugin-only`. Не переносить общую Agent Skills семантику имени на Claude без source-specific resolver.

Fixture user roots: `$CLAUDE_CONFIG_DIR/skills/{collision,user-only}`. Project roots: `.claude/skills/{collision,project-only,hidden-front,hidden-off,hidden-ui,name-mode}`; commands `.claude/commands/{command-only.md,nested/nested-only.md}`. Inline plugin имеет manifest name `fixture` и `skills/plugin-only/SKILL.md`. User settings: `disableBundledSkills:true`, overrides `hidden-off:off`, `hidden-ui:user-invocable-only`, `name-mode:name-only`.

`skill_listing.names`, baseline и env1 **одинаковы**:

```json
["collision","user-only","name-mode","project-only","command-only","nested:nested-only","fixture:plugin-only","plugin-authoring"]
```

Baseline attachment:

```text
- collision: USER_COLLISION_DESCRIPTION
- user-only: USER_DESCRIPTION
- name-mode
- project-only: PROJECT_DESCRIPTION
- command-only: COMMAND_DESCRIPTION
- nested:nested-only: NESTED_COMMAND_DESCRIPTION
- fixture:plugin-only: PLUGIN_DESCRIPTION
- plugin-authoring: <bundled description retained>
```

Env1 attachment:

```text
- collision
- user-only
- name-mode
- project-only
- command-only
- nested:nested-only
- fixture:plugin-only
- plugin-authoring: <bundled description retained>
```

Это сравнение сделано по JSONL `attachment.type=skill_listing` и исходящему payload. **Не по `system/init.skills`:** init дополнительно перечисляет `hidden-front`, `hidden-ui`, `doctor`, а команды в этом поле отсутствуют. Для проверки доступности навигатора нужно attachment.names, не menu inventory.

В payload нет `PROJECT_COLLISION_DESCRIPTION`; user победил project. `hidden-off` не входит и в init.skills. Nested command имя `nested:nested-only`. Symlink/cycle, enterprise policy, ancestor project roots, plugin/project settings precedence и installed marketplace scope не проверялись этой fixture; их resolver нельзя объявить проверенным из одного local списка. P03 отвечает за plugin management scopes, не этот файл.

Source excerpt из embedded JS установленного executable:

```js
skillListingBudgetFraction:()=>C().gt(0).lte(1).optional()
function ulo(){return tt().skillListingBudgetFraction??llo}
function h4e(e,n=TRt){let r=PL(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
 if(r)return r;let s=ulo(),g=(e??dlo)*n*s;return Math.max(1,Math.floor(g))}
```

Settings0 probe добавляет `--settings '{"skillListingBudgetFraction":0}'`: exit 0, descriptions исходящего payload сохранены. Env1 debug: `Skill listing over budget: 8 skills, 494 chars > 1 budget`. Фракция малая положительная отдельно не проверялась.

## Jev: session-specific выключение

Локальная установка: `~/.claude/skills/jev-skill-suggestion`, manifest `jev-skill-suggestion` v0.1.0; `hooks/hooks.json` содержит native modules `./jev-skill-suggestion.ts`, не набор command hook matchers. README этой установки подтверждает auto-load id `jev-skill-suggestion@skills-dir` и другой id для inline load. Опции провайдера/ключей не читались и не выводились.

Контрольные settings, дополнительно к session hooks/statusLine:

```json
{"enabledPlugins":{"jev-skill-suggestion@skills-dir":true}}
{"enabledPlugins":{"jev-skill-suggestion@skills-dir":false}}
```

При обеих проверках `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Enabled: init.plugins содержит этот exact source, API requests=2 (первый без tools — native classifier, второй main), main payload **без** skill listing. Disabled: init.plugins не содержит jev, API requests=1, main payload **с** listing. Синтетический classifier ответ не валиден для выбора скилла, поэтому `skill_relevance` не вставлен; нельзя заявлять успешную accuracy/gating Jev.

SessionStart/UserPromptSubmit/Stop/SessionEnd записаны в обоих прогонах. Глобальный `skillOverrides` пользователя (на этой машине 86 `user-invocable-only`) не восстанавливается временным выключением мода: скрытые человеком скиллы продолжают оставаться скрытыми. `setup restore` не выполнялся. `disableAllHooks`, `--safe-mode`, `--bare`, выключение всех function hooks не предлагаются: они не эквивалентны точечному исключению jev.

## Главная роль и субагент

Дополнительные argv:

```text
--agents '{"main":{"description":"Main fixture","prompt":"MAIN_ROLE_FIXTURE...",
 "tools":["Task","Skill","mcp__parley__find_skill","mcp__parley__report"]},
 "child":{"description":"Child fixture","prompt":"Child fixture probe",
 "tools":["Skill","mcp__parley__find_skill"]}}'
--agent main --allowedTools Skill Task mcp__parley__find_skill
```

Native init называет инструмент `Task`; исходящий API tools называет его `Agent`. Главный payload ограничен `Agent, Skill, mcp__parley__find_skill, mcp__parley__report`; child ограничен `Skill, mcp__parley__find_skill`. Синтетический model turn запустил настоящий CLI child через Agent; child загрузил `project-only`, затем вызвал `mcp__parley__find_skill({query:"fixture"})`. MCP journal содержит этот запрос, а следующий child payload содержит `Reply BODY_PROJECT_DESCRIPTION.`. Это положительное доказательство пути разрешённой whitelist роли; model/effort precedence и resume не проверялись.

Advanced valid runs были после копирования jev предыдущим run: jev ещё был включён и делал дополнительный classifier request/withheld main listing. Поэтому они доказывают **loader и tool availability**, а clean env1 listing доказан отдельно baseline-серией. У child `skill_listing` присутствовал: поведение соответствует модулю, работающему в главном разговоре.

Первый synthetic tool-use probe был ошибочным: SSE content_block_start input без input_json_delta привёл к missing `skill`; исправленный valid run содержит input_json_delta и successful loader. Первое roles request также выявило API `Agent` vs init `Task`. Эти неуспешные пробы не засчитываются как успешный loader/subagent evidence.

## Synced и внешние первичные источники

Account fixture `$CLAUDE_CONFIG_DIR/skills/synced/account-fixture/cloud-only/SKILL.md` не загружен. Debug сообщает reserved sync-owned root; простое наличие SKILL.md недостаточно. Нельзя выводить из этого, что synced не поддерживается CLI вообще: в fixture нет login account и синхронизированного manifest.

Официальные [skills docs](https://code.claude.com/docs/en/skills), проверены 2026-10-03: commands объединены со skills; synced требует сохранённый login/account и feature flags, API-key/nonessential-disabled сценарий не sync; plugin skills не подчиняются обычному skillOverrides; documented listing budget поддерживает env. [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) просмотрен как первичный справочник структуры плагина. `settings-reference` tool вернул Internal Error; вывод о fraction0 основан на установленной schema и native payload, не на недоступной странице.

P04 должен решить `availability=unknown` для источника, чьи account/managed/manifest правила resolver ещё не умеет повторить; не индексировать такой источник как доступный, не подменять его папкой другого аккаунта. Также учесть `syncClaudeAiSkills` settings veto и reserved sync-owned root. Фактический account-native список остаётся отдельным P32 gate.

## Воспроизведение и artifacts

Локальные обезличенные artifacts сохранены в `/tmp/parley-p01-claude`: `baseline.json`, `env1.json`, `settings0.json`, `load-env1-valid.json`, `roles-valid.json`, `jev-enabled.json`, `jev-disabled-valid.json`, соответствующие `.debug`, `events.jsonl`, `mcp-calls.jsonl`, CLI JSONL под `config/projects`. HTTP headers не сохраняются; JSON captures содержат только synthetic prompt/config/model payload.

```sh
python3 /tmp/parley-p01-claude/probe.py
python3 /tmp/parley-p01-claude/advanced.py
rg 'skill_listing' /tmp/parley-p01-claude/config/projects
```

Temp scripts ниже сохраняются здесь для долговременного воспроизведения. Первый запуск делается в **свежей** временной области (изменить все `/tmp/parley-p01-claude` literals согласованно), затем advanced. Не запускать первый script повторно поверх уже скопированного jev, если нужна clean baseline. Не копировать в fixture credentials пользователя. `mcp.py` нужен перед advanced запуском. Сервер только loopback, случайный порт, timeout 25 s на CLI; synthetic API key не секрет.

### probe.py

```python
import os,json,subprocess,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
R=Path('/tmp/parley-p01-claude'); home=R/'home'; cfg=R/'config'; proj=R/'project'; plug=R/'plugin'
for p in (home,cfg,proj,plug):p.mkdir(exist_ok=True)
def put(p,s):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
def skill(root,name,desc,extra=''):put(root/name/'SKILL.md',f'---\nname: decorative-{name}\ndescription: {desc}\n{extra}---\n\nReply BODY_{desc}.\n')
skill(cfg/'skills','collision','USER_COLLISION_DESCRIPTION')
skill(cfg/'skills','user-only','USER_DESCRIPTION')
skill(proj/'.claude/skills','collision','PROJECT_COLLISION_DESCRIPTION')
skill(proj/'.claude/skills','project-only','PROJECT_DESCRIPTION')
skill(proj/'.claude/skills','hidden-front','HIDDEN_DESCRIPTION','disable-model-invocation: true\n')
skill(proj/'.claude/skills','hidden-off','OFF_DESCRIPTION')
skill(proj/'.claude/skills','hidden-ui','UI_DESCRIPTION')
skill(proj/'.claude/skills','name-mode','NAME_MODE_DESCRIPTION')
skill(cfg/'skills/synced/account-fixture','cloud-only','CLOUD_DESCRIPTION')
put(proj/'.claude/commands/command-only.md','---\ndescription: COMMAND_DESCRIPTION\n---\nCommand fixture')
put(proj/'.claude/commands/nested/nested-only.md','---\ndescription: NESTED_COMMAND_DESCRIPTION\n---\nNested fixture')
put(plug/'.claude-plugin/plugin.json',json.dumps({'name':'fixture','version':'1.0.0'}))
skill(plug/'skills','plugin-only','PLUGIN_DESCRIPTION')
put(cfg/'settings.json',json.dumps({'disableBundledSkills':True,'skillOverrides':{'hidden-off':'off','hidden-ui':'user-invocable-only','name-mode':'name-only'}}))
requests=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append({'path':self.path,'body':req})
  mid='msg_local_fixture';model=req.get('model','claude-haiku-4-5')
  msg={'id':mid,'type':'message','role':'assistant','model':model,'content':[{'type':'text','text':'LOCAL_TRANSPORT_OK'}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':5}}
  if req.get('stream'):
   events=[('message_start',{'type':'message_start','message':dict(msg,content=[],stop_reason=None)}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'LOCAL_TRANSPORT_OK'}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':5}}),('message_stop',{'type':'message_stop'})]
   data=''.join('event: '+k+'\ndata: '+json.dumps(v)+'\n\n' for k,v in events).encode();ct='text/event-stream'
  else:data=json.dumps(msg).encode();ct='application/json'
  self.send_response(200);self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
srv=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=srv.serve_forever,daemon=True).start()
env={k:v for k,v in os.environ.items() if not k.startswith(('CLAUDE','ANTHROPIC','PARLEY','HARNAS'))}
env.update(HOME=str(home),CLAUDE_CONFIG_DIR=str(cfg),ANTHROPIC_API_KEY='local-fixture-not-a-secret',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(srv.server_port),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_AUTO_UPDATE='1')
base=['/Users/kalmbik61/.local/bin/claude','-p','Reply OK.','--model','haiku','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--plugin-dir',str(plug)]
settings={'hooks':{k:[{'hooks':[{'type':'command','command':f'cat >> {R}/events.jsonl'}]}] for k in ['SessionStart','UserPromptSubmit','Stop','SessionEnd']},'statusLine':{'type':'command','command':f'cat >> {R}/statusline.jsonl'}}
put(R/'session.json',json.dumps(settings))
def run(name,args=[],more={}):
 start=len(requests);before=time.monotonic();cmd=base+['--settings',str(R/'session.json'),'--debug-file',str(R/(name+'.debug'))]+args
 try:r=subprocess.run(cmd,cwd=proj,env=dict(env,**more),capture_output=True,text=True,timeout=25);out={'returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 except subprocess.TimeoutExpired as e:out={'timeout':True,'stdout':(e.stdout or b'').decode() if isinstance(e.stdout,bytes) else e.stdout,'stderr':(e.stderr or b'').decode() if isinstance(e.stderr,bytes) else e.stderr}
 out.update(argv=cmd,seconds=round(time.monotonic()-before,2),requests=requests[start:]);put(R/(name+'.json'),json.dumps(out,indent=2));print(name,'exit',out.get('returncode'),'timeout',out.get('timeout',False),'requests',len(out['requests']),flush=True)
 if out['requests']:
  s=json.dumps(out['requests'][0]['body']);print('descriptions',[t for t in ['USER_COLLISION','PROJECT_COLLISION','USER_DESCRIPTION','PROJECT_DESCRIPTION','HIDDEN_DESCRIPTION','OFF_DESCRIPTION','UI_DESCRIPTION','NAME_MODE_DESCRIPTION','CLOUD_DESCRIPTION','PLUGIN_DESCRIPTION','COMMAND_DESCRIPTION','NESTED_COMMAND_DESCRIPTION'] if t in s],flush=True)
  for line in out['stdout'].splitlines():
   try:d=json.loads(line)
   except:continue
   if d.get('type')=='system' and d.get('subtype')=='init':print('init tools',d.get('tools'), 'skills',d.get('skills'),flush=True)
 return out
run('baseline')
run('env1',more={'SLASH_COMMAND_TOOL_CHAR_BUDGET':'1'})
run('settings0',['--settings','{"skillListingBudgetFraction":0}'])
srv.shutdown()
```

### mcp.py

```python
import json,sys
for line in sys.stdin:
 try:r=json.loads(line)
 except:continue
 if 'id' not in r:continue
 method=r.get('method');res={}
 if method=='initialize':res={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'parley-fixture','version':'0'}}
 elif method=='tools/list':res={'tools':[{'name':'find_skill','description':'Fixture skill lookup','inputSchema':{'type':'object','properties':{'query':{'type':'string'}},'required':['query']}},{'name':'report','description':'Fixture report','inputSchema':{'type':'object','properties':{'status':{'type':'string'}}}}]}
 elif method=='tools/call':
  with open('/tmp/parley-p01-claude/mcp-calls.jsonl','a') as f:f.write(json.dumps(r.get('params'))+'\n')
  res={'content':[{'type':'text','text':json.dumps({'name':'project-only','load':'Skill(project-only)','source':'project'})}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':res}),flush=True)
```

### advanced.py

```python
import os,json,subprocess,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
R=Path('/tmp/parley-p01-claude'); home=R/'home'; cfg=R/'config'; proj=R/'project'; plug=R/'plugin'
for p in (home,cfg,proj,plug):p.mkdir(exist_ok=True)
def put(p,s):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
def skill(root,name,desc,extra=''):put(root/name/'SKILL.md',f'---\nname: decorative-{name}\ndescription: {desc}\n{extra}---\n\nReply BODY_{desc}.\n')
skill(cfg/'skills','collision','USER_COLLISION_DESCRIPTION')
skill(cfg/'skills','user-only','USER_DESCRIPTION')
skill(proj/'.claude/skills','collision','PROJECT_COLLISION_DESCRIPTION')
skill(proj/'.claude/skills','project-only','PROJECT_DESCRIPTION')
skill(proj/'.claude/skills','hidden-front','HIDDEN_DESCRIPTION','disable-model-invocation: true\n')
skill(proj/'.claude/skills','hidden-off','OFF_DESCRIPTION')
skill(proj/'.claude/skills','hidden-ui','UI_DESCRIPTION')
skill(proj/'.claude/skills','name-mode','NAME_MODE_DESCRIPTION')
skill(cfg/'skills/synced/account-fixture','cloud-only','CLOUD_DESCRIPTION')
put(proj/'.claude/commands/command-only.md','---\ndescription: COMMAND_DESCRIPTION\n---\nCommand fixture')
put(proj/'.claude/commands/nested/nested-only.md','---\ndescription: NESTED_COMMAND_DESCRIPTION\n---\nNested fixture')
put(plug/'.claude-plugin/plugin.json',json.dumps({'name':'fixture','version':'1.0.0'}))
skill(plug/'skills','plugin-only','PLUGIN_DESCRIPTION')
put(cfg/'settings.json',json.dumps({'disableBundledSkills':True,'skillOverrides':{'hidden-off':'off','hidden-ui':'user-invocable-only','name-mode':'name-only'}}))
requests=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append({'path':self.path,'body':req})
  mid='msg_local_fixture';model=req.get('model','claude-haiku-4-5')
  msg={'id':mid,'type':'message','role':'assistant','model':model,'content':[{'type':'text','text':'LOCAL_TRANSPORT_OK'}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':5}}
  msg=adjust(req,msg)
  if req.get('stream'):
   events=[('message_start',{'type':'message_start','message':dict(msg,content=[],stop_reason=None)}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'LOCAL_TRANSPORT_OK'}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':5}}),('message_stop',{'type':'message_stop'})]
   if msg['content'][0]['type']=='tool_use':
    events=[('message_start',{'type':'message_start','message':dict(msg,content=[],stop_reason=None)}),('content_block_start',{'type':'content_block_start','index':0,'content_block':dict(msg['content'][0],input={})}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(msg['content'][0]['input'])}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'tool_use','stop_sequence':None},'usage':{'output_tokens':5}}),('message_stop',{'type':'message_stop'})]
   data=''.join('event: '+k+'\ndata: '+json.dumps(v)+'\n\n' for k,v in events).encode();ct='text/event-stream'
  else:data=json.dumps(msg).encode();ct='application/json'
  self.send_response(200);self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
srv=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=srv.serve_forever,daemon=True).start()
env={k:v for k,v in os.environ.items() if not k.startswith(('CLAUDE','ANTHROPIC','PARLEY','HARNAS'))}
env.update(HOME=str(home),CLAUDE_CONFIG_DIR=str(cfg),ANTHROPIC_API_KEY='local-fixture-not-a-secret',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(srv.server_port),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_AUTO_UPDATE='1')
base=['/Users/kalmbik61/.local/bin/claude','-p','Reply OK.','--model','haiku','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--plugin-dir',str(plug)]
settings={'hooks':{k:[{'hooks':[{'type':'command','command':f'cat >> {R}/events.jsonl'}]}] for k in ['SessionStart','UserPromptSubmit','Stop','SessionEnd']},'statusLine':{'type':'command','command':f'cat >> {R}/statusline.jsonl'}}
put(R/'session.json',json.dumps(settings))
def run(name,args=[],more={}):
 start=len(requests);before=time.monotonic();cmd=base+['--settings',str(R/'session.json'),'--debug-file',str(R/(name+'.debug'))]+args
 try:r=subprocess.run(cmd,cwd=proj,env=dict(env,**more),capture_output=True,text=True,timeout=25);out={'returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 except subprocess.TimeoutExpired as e:out={'timeout':True,'stdout':(e.stdout or b'').decode() if isinstance(e.stdout,bytes) else e.stdout,'stderr':(e.stderr or b'').decode() if isinstance(e.stderr,bytes) else e.stderr}
 out.update(argv=cmd,seconds=round(time.monotonic()-before,2),requests=requests[start:]);put(R/(name+'.json'),json.dumps(out,indent=2));print(name,'exit',out.get('returncode'),'timeout',out.get('timeout',False),'requests',len(out['requests']),flush=True)
 if out['requests']:
  s=json.dumps(out['requests'][0]['body']);print('descriptions',[t for t in ['USER_COLLISION','PROJECT_COLLISION','USER_DESCRIPTION','PROJECT_DESCRIPTION','HIDDEN_DESCRIPTION','OFF_DESCRIPTION','UI_DESCRIPTION','NAME_MODE_DESCRIPTION','CLOUD_DESCRIPTION','PLUGIN_DESCRIPTION','COMMAND_DESCRIPTION','NESTED_COMMAND_DESCRIPTION'] if t in s],flush=True)
  for line in out['stdout'].splitlines():
   try:d=json.loads(line)
   except:continue
   if d.get('type')=='system' and d.get('subtype')=='init':print('init tools',d.get('tools'), 'skills',d.get('skills'),flush=True)
 return out

mode='plain'
def adjust(req,msg):
 global mode
 text=json.dumps(req.get('messages',[]));tools=[t['name'] for t in req.get('tools',[])];name=None;inp={}
 if mode=='load' and 'tool_result' not in text:name='Skill';inp={'skill':'project-only'}
 if mode=='roles':
  if 'CHILD_PROBE' not in text and 'tool_result' not in text:name='Agent';inp={'subagent_type':'child','description':'Probe child','prompt':'CHILD_PROBE: use project-only skill and find_skill'}
  elif 'CHILD_PROBE' in text and 'tool_result' not in text:name='Skill';inp={'skill':'project-only'}
  elif 'CHILD_PROBE' in text and 'mcp__parley__find_skill' not in text:name='mcp__parley__find_skill';inp={'query':'fixture'}
 if name and name in tools:msg.update(content=[{'type':'tool_use','id':'tool_fixture_'+str(len(requests)),'name':name,'input':inp}],stop_reason='tool_use')
 return msg
mcp={'mcpServers':{'parley':{'command':'python3','args':[str(R/'mcp.py')]}}}
base[base.index('--mcp-config')+1]=json.dumps(mcp)
mode='load'
run('load-env1-valid',['--allowedTools','Skill'],{'SLASH_COMMAND_TOOL_CHAR_BUDGET':'1'})
mode='roles'
agents={'main':{'description':'Main fixture','prompt':'MAIN_ROLE_FIXTURE. Spawn child for CHILD_PROBE.','tools':['Task','Skill','mcp__parley__find_skill','mcp__parley__report']},'child':{'description':'Child fixture','prompt':'Child fixture probe','tools':['Skill','mcp__parley__find_skill']}}
run('roles-valid',['--agents',json.dumps(agents),'--agent','main','--allowedTools','Skill','Task','mcp__parley__find_skill'],{'SLASH_COMMAND_TOOL_CHAR_BUDGET':'1'})
mode='plain'
import shutil
shutil.copytree('/Users/kalmbik61/.claude/skills/jev-skill-suggestion',cfg/'skills/jev-skill-suggestion',dirs_exist_ok=True)
run('jev-enabled',['--settings',json.dumps(dict(settings,enabledPlugins={'jev-skill-suggestion@skills-dir':True}))],{'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS':'1'})
run('jev-disabled-valid',['--settings',json.dumps(dict(settings,enabledPlugins={'jev-skill-suggestion@skills-dir':False}))],{'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS':'1'})
srv.shutdown()
```
