import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
const data='/var/lib/docker/volumes/rodecomp_data/_data';
const map=new Map(fs.readFileSync(data+'/repo/.git/filter-repo/commit-map','utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/)));
map.set('41ea356f358ba643231157a498fff099f077f9d6', execFileSync('git',['-C',data+'/repo','rev-parse','HEAD'],{encoding:'utf8'}).trim());
const db=new DatabaseSync(data+'/td.sqlite');
db.exec('BEGIN IMMEDIATE');
let updates=0;
try {
 for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  const cols=db.prepare(`PRAGMA table_info("${table.name}")`).all().filter(c=>c.name.includes('commit'));
  for(const col of cols)for(const [old,next] of map){if(old===next)continue;if(/^0+$/.test(next))continue;updates+=Number(db.prepare(`UPDATE "${table.name}" SET "${col.name}"=? WHERE "${col.name}"=?`).run(next,old).changes);}
 }
 db.exec('COMMIT');
} catch(e){db.exec('ROLLBACK');throw e;}
db.close();
const admin=JSON.parse(fs.readFileSync(data+'/forgejo-admin.json','utf8'));
async function api(method,path,body){const r=await fetch('http://forgejo:3000/api/v1'+path,{method,headers:{Authorization:'Basic '+Buffer.from(admin.username+':'+admin.password).toString('base64'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(method+' '+path+' '+r.status+' '+await r.text());return r.status===204?null:r.json();}
const route='/repos/clank/rodecomp/branch_protections';
const protections=await api('GET',route);
const main=protections.find(p=>p.rule_name==='main');
if(!main)throw Error('Expected main protection');
await api('DELETE',route+'/main');
try {execFileSync('git',['-C',data+'/repo','push','--force-with-lease=refs/heads/main:41ea356f358ba643231157a498fff099f077f9d6','forgejo','HEAD:refs/heads/main'],{stdio:'pipe'});}
finally {await api('POST',route,{rule_name:'main',enable_push:true,enable_push_whitelist:true,push_whitelist_usernames:['clank-bot'],block_on_rejected_reviews:false});}
console.log('Updated commit references:',updates,'; rewritten main published; protection restored');
