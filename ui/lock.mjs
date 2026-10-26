// One engine runs the schedule.
//
// The menu bar app and `bisu ui` are each a full engine, and both may be open at once. Without this,
// each would run every scheduled job and every suggestion on its own clock — twice the spend, and two
// agents editing the same folder for a job that may edit. The first engine to tick takes a lock file
// with its pid; the others skip their ticks while that pid is alive, and take over when it is gone.
// A person pressing "run now" is not a tick and does not need the lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const LOCK = process.env.BISU_SCHEDULER_LOCK || path.join(os.homedir(), 'Library', 'Application Support', 'bisu', 'scheduler.lock');

// Alive and still a bisu engine: a pid left behind by a crash can be reused by any other program.
function engineAlive(pid) {
  try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return false }
  try { return /^(\S*\/)?node(\s|$)/.test(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8', timeout: 3000})) } catch { return false }
}

export function holdsSchedule() {
  try { fs.mkdirSync(path.dirname(LOCK), {recursive: true}) } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      // A lock that cannot be made at all (read-only disk) must not stop the schedule.
      if (e.code !== 'EEXIST') return true;
    }
    let pid = 0;
    try { pid = Number(fs.readFileSync(LOCK, 'utf8').trim()) } catch {}
    if (pid === process.pid) return true;
    if (pid > 0 && engineAlive(pid)) return false;
    try { fs.unlinkSync(LOCK) } catch {}
  }
  return false;
}

export function releaseSchedule() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK) } catch {}
}
