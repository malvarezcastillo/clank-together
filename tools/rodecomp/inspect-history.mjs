import {DatabaseSync} from 'node:sqlite';
const d=new DatabaseSync('/var/lib/docker/volumes/rodecomp_data/_data/td.sqlite',{readOnly:true});
for(const t of d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
 const cols=d.prepare(`PRAGMA table_info("${t.name}")`).all().filter(c=>/commit/.test(c.name));
 if(cols.length) console.log(t.name,JSON.stringify(cols.map(c=>c.name)));
}
console.log('attempts',d.prepare('SELECT state,count(*) n FROM attempts GROUP BY state').all());
console.log('tasks',d.prepare('SELECT state,count(*) n FROM tasks GROUP BY state').all());
d.close();
