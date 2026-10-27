import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {checkPublic} from './check.mjs';
const root=resolve(import.meta.dirname,'..');
const source=resolve(root,'public');
const dist=resolve(root,'dist');
const checked=await checkPublic(source);
await mkdir(dist,{recursive:true});
for(const item of checked.files){const target=resolve(dist,item.path);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(source,item.path),target);}
const gitCommit=process.env.GITHUB_SHA||null;
if(gitCommit)assert(/^[a-f0-9]{40}$/.test(gitCommit),'Expected an immutable GitHub commit SHA');
let runUrl=null;
if(process.env.GITHUB_RUN_ID){assert.equal(process.env.GITHUB_REPOSITORY,'synchronic1/AIPSTER');assert(/^\d+$/.test(process.env.GITHUB_RUN_ID));runUrl=`https://github.com/synchronic1/AIPSTER/actions/runs/${process.env.GITHUB_RUN_ID}`;}
const provenance={site:'aipster-public-site',site_revision:checked.revision,git_commit:gitCommit,github_run_url:runUrl,source_manifest_sha256:checked.manifest_sha256,auth_deployed:false};
await writeFile(resolve(dist,'deployment.json'),JSON.stringify(provenance)+'\n');
// Fail on stale or unexpected output; never deploy an uncontrolled directory.
async function list(dir,prefix=''){const entries=[];for(const item of await readdir(dir,{withFileTypes:true})){assert(!item.isSymbolicLink());const path=prefix+item.name;if(item.isDirectory())entries.push(...await list(resolve(dir,item.name),path+'/'));else entries.push(path);}return entries.sort();}
assert.deepEqual(await list(dist),[...checked.files.map(x=>x.path),'deployment.json'].sort());
for(const item of checked.files)assert.deepEqual(await readFile(resolve(dist,item.path)),await readFile(resolve(source,item.path)));
await mkdir(resolve(root,'.verification'),{recursive:true});
await writeFile(resolve(root,'.verification/build.json'),JSON.stringify({...provenance,files:checked.files},null,2)+'\n');
console.log(JSON.stringify({built:true,assets:checked.files.length+1,...provenance}));
