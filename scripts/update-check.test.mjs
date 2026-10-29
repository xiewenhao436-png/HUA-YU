import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dailyAppUpdateStatus } from '../src/update-check.mjs';
test('daily check shares concurrent requests and persists successful days', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huayu-daily-'));
 try {
 let calls = 0; const options = { statePath: path.join(dir,'state.json'), now: new Date(2026,9,29), status: async (args) => { if(args.checkRemote) calls++; return { installedVersion:'0.1.0', latestVersion:'0.2.0', updateAvailable:true }; } };
 await Promise.all([dailyAppUpdateStatus(options),dailyAppUpdateStatus(options)]);
 assert.equal(calls,1); assert.equal((await dailyAppUpdateStatus(options)).dailyCheck.cached,true);
 await dailyAppUpdateStatus({...options,force:true}); assert.equal(calls,2);
 await dailyAppUpdateStatus({...options,now:new Date(2026,9,30)}); assert.equal(calls,3);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('failed checks stay retryable and never report current', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huayu-daily-'));
 try { let calls=0; const options={ statePath:path.join(dir,'state.json'),status:async()=>{calls++;throw Error('offline');}};
 assert.equal((await dailyAppUpdateStatus(options)).blockedReason,'release-check-failed');
 await dailyAppUpdateStatus(options); assert.equal(calls,2);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('cached remote metadata recomputes installed state; force bypasses provider cache', async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'huayu-daily-')); let version='0.1.0'; let forced=false;
 const options={statePath:path.join(dir,'state.json'),status:async args=>{forced=args.forceRemote;return {installedVersion:version,publishedRelease:{version:'0.2.0'}};}};
 try {await dailyAppUpdateStatus(options);version='0.2.0';assert.equal((await dailyAppUpdateStatus(options)).installedVersion,'0.2.0');await dailyAppUpdateStatus({...options,force:true});assert.equal(forced,true);} finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('non-git installation discovers releases and preserves check errors', async()=>{
 const {appUpdateStatus}=await import('../src/updater.mjs'); const dir=await fs.mkdtemp(path.join(os.tmpdir(),'huayu-package-'));
 try {await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'huayu',version:'0.1.0',repository:{url:'https://github.com/xiewenhao436-png/HUA-YU.git'}}));
 const options={rootDir:dir,discoverInstall:false,checkRemote:true};
 const found=await appUpdateStatus({...options,releaseProvider:async()=>({tag:'v0.2.0',version:'0.2.0',commit:'a'.repeat(40),url:'https://github.com/xiewenhao436-png/HUA-YU/releases/tag/v0.2.0'})});
 assert.equal(found.updateAvailable,true);assert.equal(found.latestVersion,'0.2.0');assert.equal(found.canUpdate,false);
 const failed=await appUpdateStatus({...options,releaseProvider:async()=>{throw Error('GitHub release API returned 403.');}}); assert.match(failed.releaseError,/403/);assert.equal(failed.latestVersion,null);
 const empty=await appUpdateStatus({...options,releaseProvider:async()=>null});assert.equal(empty.releaseError,null);assert.equal(empty.latestVersion,null);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
