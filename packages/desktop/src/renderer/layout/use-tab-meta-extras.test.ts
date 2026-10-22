/**
 * `needSessionKeys` — какие сессии снимка ждут человека (`SessionActivity.need`): по ним вкладка комнаты получает
 * подкраску (спека застрявших 7.3). Живая сессия — да, спящая, закрытая и без записи активности — нет.
 */

import { describe, expect, it } from 'vitest';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeNeed, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { needSessionKeys } from './use-tab-meta-extras.js';

const PROJECT = '/tmp/proj';
const REF = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-01', sessionId });

describe('needSessionKeys', () => {
  it('ключи живых сессий с need; без need, спящие, закрытые и без записи активности — нет', () => {
    const entry = makeWork('w-01', {
      projectPath: PROJECT,
      sessions: [
        makeSession('s-01', 'a'),
        makeSession('s-02', 'b'),
        makeSession('s-03', 'c', { lifecycle: 'sleeping' }),
        makeSession('s-04', 'd', { lifecycle: 'closed' }),
        makeSession('s-05', 'e'),
      ],
    });
    const byRef = activityMap([
      makeActivity(REF('s-01'), 'unseen', { need: makeNeed('limit') }),
      makeActivity(REF('s-02'), 'unseen'),
      makeActivity(REF('s-03'), 'idle', { need: makeNeed('limit') }),
      makeActivity(REF('s-04'), 'idle', { need: makeNeed('sign-in') }),
    ]);
    expect(needSessionKeys([entry], byRef)).toEqual([refKey(REF('s-01'))]);
  });
});
