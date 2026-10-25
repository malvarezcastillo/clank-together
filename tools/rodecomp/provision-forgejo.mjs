import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const data='/var/lib/docker/volumes/rodecomp_data/_data';
const secretsFile=data+'/forgejo-admin.json';
const secrets=fs.existsSync(secretsFile)?JSON.parse(fs.readFileSync(secretsFile,'utf8')):{username:'clank-admin',password:crypto.randomBytes(30).toString('base64url')};
if(!fs.existsSync(secretsFile))fs.writeFileSync(secretsFile,JSON.stringify(secrets),{mode:0o600});
const fj=(args)=>execFileSync('docker',['exec','--user','git','rodecomp-forgejo-1','forgejo','--config','/data/gitea/conf/app.ini',...args],{encoding:'utf8'});
const users=fj(['admin','user','list']);
if(!users.includes(secrets.username))fj(['admin','user','create','--admin','--username',secrets.username,'--email','admin@rodecomp.online','--password',secrets.password,'--must-change-password=false']);
if(!users.includes('clank-bot'))fj(['admin','user','create','--username','clank-bot','--email','bot@rodecomp.online','--random-password','--must-change-password=false']);
async function api(method,url,body){const r=await fetch('http://forgejo:3000/api/v1'+url,{method,headers:{Authorization:'Basic '+Buffer.from(secrets.username+':'+secrets.password).toString('base64'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(method+' '+url+' '+r.status+' '+await r.text());return r.status===204?null:r.json();}
let r=await fetch('http://forgejo:3000/api/v1/orgs/clank');
if(r.status===404)await api('POST','/orgs',{username:'clank',full_name:'Clank Together',visibility:'public'});
r=await fetch('http://forgejo:3000/api/v1/repos/clank/rodecomp');
if(r.status===404)await api('POST','/orgs/clank/repos',{name:'rodecomp',description:'Ragnarok Online reconstruction through Clank Together',private:false,default_branch:'main'});
await api('PATCH','/repos/clank/rodecomp',{has_pull_requests:false,has_actions:false,has_packages:false,has_releases:false,has_projects:false,website:'https://clank.rodecomp.online/'});
await api('PUT','/repos/clank/rodecomp/collaborators/clank-bot',{permission:'write'});
const git=(args)=>execFileSync('git',['-C',data+'/repo',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
if(!git(['remote']).split('\n').includes('forgejo')){
 const token=fj(['admin','user','generate-access-token','--username','clank-bot','--token-name','coordinator','--scopes','write:repository','--raw']).trim();
 git(['remote','add','forgejo',`http://clank-bot:${token}@forgejo:3000/clank/rodecomp.git`]);
}
git(['push','forgejo','HEAD:refs/heads/main']);
const protections=await api('GET','/repos/clank/rodecomp/branch_protections');
if(!protections.some(p=>p.rule_name==='main'))await api('POST','/repos/clank/rodecomp/branch_protections',{rule_name:'main',enable_push:true,enable_push_whitelist:true,push_whitelist_usernames:['clank-bot'],block_on_rejected_reviews:false});
const file=data+'/server.json';const config=JSON.parse(fs.readFileSync(file,'utf8'));
Object.assign(config,{pushRemote:'forgejo',gitCloneUrl:'https://clank.rodecomp.online/git/clank/rodecomp.git',gitWebUrl:'https://clank.rodecomp.online/git/clank/rodecomp'});
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n');
console.log('Published clank/rodecomp; main protected; coordinator push enabled. Forgejo admin credential stored privately in '+secretsFile);
