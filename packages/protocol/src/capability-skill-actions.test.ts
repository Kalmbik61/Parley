import { expect, it } from 'vitest';
import { capabilitySkillResult, capabilitySkillTarget } from './capability-skill-actions.js';
const input={projectPath:'/project',provider:'claude',revision:2,presenceId:'opaque-presence'};
it('current opaque manual target refuses caller chosen source/destination/scope and invalid revisions',()=>{
 expect(capabilitySkillTarget.safeParse(input).success).toBe(true);
 for(const extra of [{source:'/secret'},{destination:'/secret'},{scope:'user'},{revision:-1},{revision:2.2},{revision:Number.MAX_SAFE_INTEGER+1},{presenceId:'\uD800'},{presenceId:'x'.repeat(8193)}])expect(capabilitySkillTarget.safeParse({...input,...extra}).success).toBe(false);
 expect(capabilitySkillTarget.safeParse({...input,projectPath:'/project/🚀',presenceId:'native-\u2028copy'}).success).toBe(true);
});
it('fixed bounded results never disclose paths/errors or fabricate success',()=>{
 expect(capabilitySkillResult.safeParse({outcome:'ok',code:'ok',scope:'project'}).success).toBe(true);
 expect(capabilitySkillResult.safeParse({outcome:'failed',code:'symlink-error'}).success).toBe(true);
 for(const result of [{outcome:'ok',code:'ok'},{outcome:'ok',code:'io-error',scope:'project'},{outcome:'denied',code:'ok'},{outcome:'ok',code:'ok',scope:'local'},{outcome:'failed',code:'io-error',error:'/secret'}])expect(capabilitySkillResult.safeParse(result).success).toBe(false);
});
