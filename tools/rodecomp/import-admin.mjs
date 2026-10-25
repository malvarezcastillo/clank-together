import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const u = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if(u.name !== 'ragnarok-clanker' || u.role !== 'admin' || u.status !== 'active') throw new Error('Unexpected administrator record');
db.prepare('INSERT INTO users (name,password_hash,role,status,created_at,approved_at) VALUES (?,?,?,?,?,?)').run(u.name,u.password_hash,u.role,u.status,u.created_at,u.approved_at);
console.log('Imported active administrator',u.name);
db.close();
