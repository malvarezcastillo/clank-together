import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const data='/var/lib/docker/volumes/rodecomp_data/_data',repo=data+'/repo';
const git=(args,opts={})=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',...opts}).trim();
if(git(['status','--porcelain']))throw Error('Canonical checkout has uncommitted changes');
const previous=git(['rev-parse','HEAD']),tree=git(['rev-parse','HEAD^{tree}']);
const identity={...process.env,GIT_AUTHOR_NAME:'ragnarok-clanker',GIT_AUTHOR_EMAIL:'ragnarok-clanker',GIT_COMMITTER_NAME:'ragnarok-clanker',GIT_COMMITTER_EMAIL:'ragnarok-clanker'};
const root=git(['commit-tree',tree],{input:'Initial rodecomp source snapshot\n',env:identity});
fs.writeFileSync(data+'/history-reset.json',JSON.stringify({previous,root,tree},null,2));
git(['update-ref','refs/heads/main',root,previous]);
for(const ref of git(['for-each-ref','--format=%(refname)']).split('\n'))if(ref&&ref!=='refs/heads/main')git(['update-ref','-d',ref]);
git(['reset','--hard',root]);git(['config','user.name','ragnarok-clanker']);git(['config','user.email','ragnarok-clanker']);
const db=new DatabaseSync(data+'/td.sqlite');db.exec('BEGIN IMMEDIATE');
try{for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())for(const c of db.prepare(`PRAGMA table_info("${table.name}")`).all().filter(c=>c.name.includes('commit')))db.prepare(`UPDATE "${table.name}" SET "${c.name}"=? WHERE "${c.name}" IS NOT NULL`).run(root);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}db.close();
const a=JSON.parse(fs.readFileSync(data+'/forgejo-admin.json','utf8'));
async function api(method,url,body){const r=await fetch('http://forgejo:3000/api/v1'+url,{method,headers:{Authorization:'Basic '+Buffer.from(a.username+':'+a.password).toString('base64'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(method+' '+r.status+' '+await r.text());}
const route='/repos/clank/rodecomp/branch_protections';await api('DELETE',route+'/main');
try{git(['push','--force-with-lease=refs/heads/main:'+previous,'forgejo','HEAD:refs/heads/main']);}finally{await api('POST',route,{rule_name:'main',enable_push:true,enable_push_whitelist:true,push_whitelist_usernames:['clank-bot'],block_on_rejected_reviews:false});}
git(['reflog','expire','--expire=now','--all']);git(['gc','--prune=now']);
console.log(JSON.stringify({previous,root,tree,commits:git(['rev-list','--count','--all'])}));
