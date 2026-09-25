import {createPreferenceAutosave} from '../src/preference-autosave';
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
beforeEach(()=>jest.useFakeTimers());afterEach(()=>jest.useRealTimers());
test('coalesces rapid typing and flushes the last edit on navigation',async()=>{
 const commit=jest.fn(async(_kind:string,value:string)=>value);const state=jest.fn();const q=createPreferenceAutosave(commit,state);
 q.schedule('voice','a');jest.advanceTimersByTime(300);q.schedule('voice','ab');jest.advanceTimersByTime(400);await tick();expect(commit).not.toHaveBeenCalled();
 await q.flush();expect(commit).toHaveBeenCalledTimes(1);expect(commit).toHaveBeenCalledWith('voice','ab');expect(state).toHaveBeenLastCalledWith('voice',{phase:'saved',result:'ab'});q.dispose();expect(jest.getTimerCount()).toBe(0);
});
test('serializes changes and cannot publish stale success after a newer edit',async()=>{
 let release!:(v:string)=>void;const commit=jest.fn().mockImplementationOnce(()=>new Promise(r=>{release=r;})).mockResolvedValue('latest');const state=jest.fn();const q=createPreferenceAutosave<string,string,string>(commit,state);
 q.schedule('voice','first',0);jest.runOnlyPendingTimers();await tick();q.schedule('voice','second',0);q.schedule('voice','third',0);q.schedule('backend','backend',0);jest.runOnlyPendingTimers();await tick();expect(commit).toHaveBeenCalledTimes(1);
 release('old');await q.flush();expect(commit.mock.calls).toEqual([['voice','first'],['voice','third'],['backend','backend']]);expect(state.mock.calls.some(c=>c[1].result==='old')).toBe(false);q.dispose();
});
test('failure remains visible without automatic retry; a correction or explicit retry recovers',async()=>{
 const error=new Error('network');const commit=jest.fn().mockRejectedValueOnce(error).mockResolvedValue('applied');const state=jest.fn();const q=createPreferenceAutosave<string,string,string>(commit,state);
 q.schedule('voice','draft');await expect(q.flush()).rejects.toBe(error);expect(state).toHaveBeenLastCalledWith('voice',{phase:'error',error});jest.advanceTimersByTime(10000);await tick();expect(commit).toHaveBeenCalledTimes(1);
 await q.retry('voice');expect(commit).toHaveBeenCalledTimes(2);expect(state).toHaveBeenLastCalledWith('voice',{phase:'saved',result:'applied'});q.dispose();
});
test('a newer edit supersedes an in-flight error and disposed queues stop UI updates',async()=>{
 let reject!:(e:Error)=>void;const commit=jest.fn().mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;})).mockResolvedValue('ok');const state=jest.fn();const q=createPreferenceAutosave<string,string,string>(commit,state);
 q.schedule('voice','old',0);jest.runOnlyPendingTimers();await tick();q.schedule('voice','new');reject(new Error('old failure'));await q.flush();expect(state.mock.calls.some(c=>c[1].phase==='error')).toBe(false);
 q.schedule('voice','not-written');q.dispose();jest.runOnlyPendingTimers();await tick();expect(commit).toHaveBeenCalledTimes(2);expect(jest.getTimerCount()).toBe(0);
});

test('a new session retries only failed drafts and also flushes pending edits',async()=>{
 const commit=jest.fn().mockRejectedValueOnce(new Error('session ended')).mockResolvedValue('saved');const q=createPreferenceAutosave<string,string,string>(commit,jest.fn());
 q.schedule('voice','voice-draft');await expect(q.flush()).rejects.toThrow('session ended');
 q.schedule('backend','backend-draft');await q.retryFailed();
 expect(commit.mock.calls).toEqual([['voice','voice-draft'],['backend','backend-draft'],['voice','voice-draft']]);
 await q.retryFailed();expect(commit).toHaveBeenCalledTimes(3);q.dispose();
});
