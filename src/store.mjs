import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,time TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS simulated_effects(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  save(run){ this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,run.owner,JSON.stringify(run)); }
  get(id){ const row=this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);return row?JSON.parse(row.body):null; }
  event(id,type,message,details={}) { this.db.prepare('INSERT INTO events(run_id,time,type,message,details) VALUES(?,?,?,?,?)').run(id,new Date().toISOString(),type,message,JSON.stringify(details)); }
  events(id){return this.db.prepare('SELECT seq,time,type,message,details FROM events WHERE run_id=? ORDER BY seq').all(id).map(x=>({...x,details:JSON.parse(x.details)}));}
  op(id){const r=this.db.prepare('SELECT body FROM operations WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
  putOp(op){this.db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(op.id,op.runId,op.status,JSON.stringify(op));}
  operations(runId){return this.db.prepare('SELECT body FROM operations WHERE run_id=? ORDER BY rowid').all(runId).map(x=>JSON.parse(x.body));}
  effect(id){const r=this.db.prepare('SELECT body FROM simulated_effects WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
  putEffect(id,runId,body){this.db.prepare('INSERT INTO simulated_effects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,runId,JSON.stringify(body));}
  effects(runId){return this.db.prepare('SELECT body FROM simulated_effects WHERE run_id=? ORDER BY rowid').all(runId).map(x=>JSON.parse(x.body));}
  session(id){return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);}
  putSession(id,csrf){this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(id,csrf,Date.now());}
  close(){this.db.close();}
}
