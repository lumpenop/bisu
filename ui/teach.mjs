// Show and teach: the person does a task on the Mac once while dec-intern watches, and the steps become a routine.
//
// The shell (mac/native/dec-intern.swift) records; this file keeps and describes what it recorded:
//  * a step is one of {type:'app', app}, {type:'click', app, role, title}, {type:'type', app, field, text},
//    {type:'shortcut', app, keys}. The shell never records password fields or anything typed while macOS
//    has secure input on, and it reads a field's text once when the typing is done rather than keystrokes.
//  * the steps stay on this Mac (~/.config/dec-intern/teach/<time>.json). What goes to the model is only the
//    one-line description of each step below, never a screenshot.
//  * the description starts an ordinary chat of the bot, which turns it into a routine with routine_save, so
//    the person sees the draft and agrees before anything is saved; a later run does the steps with the cu_*
//    tools (look, click, type, press keys).
import './migrate.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dec-intern', 'teach');
const MAX = 200;
const one = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ROLE = { AXButton: '버튼', AXMenuItem: '메뉴 항목', AXMenuBarItem: '메뉴', AXTextField: '입력 칸', AXTextArea: '입력 칸', AXCheckBox: '체크박스', AXRadioButton: '선택지', AXPopUpButton: '팝업 메뉴', AXLink: '링크', AXCell: '목록 항목', AXRow: '목록 항목', AXStaticText: '글자', AXImage: '그림', AXTab: '탭', AXTabGroup: '탭' };

// Only the fields a step may have, trimmed; anything else the shell sent is dropped.
export function clean(steps) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps.slice(0, MAX) : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.secure) continue;
    if (s.type === 'app' && one(s.app, 60)) out.push({ type: 'app', app: one(s.app, 60) });
    else if (s.type === 'click') out.push({ type: 'click', app: one(s.app, 60), role: one(s.role, 40), title: one(s.title, 80) });
    else if (s.type === 'type' && one(s.text, 200)) out.push({ type: 'type', app: one(s.app, 60), field: one(s.field, 60), text: one(s.text, 200) });
    else if (s.type === 'shortcut' && one(s.keys, 20)) out.push({ type: 'shortcut', app: one(s.app, 60), keys: one(s.keys, 20) });
  }
  // The same app twice in a row, or a click on nothing nameable followed by another, adds nothing.
  return out.filter((s, i) => !(s.type === 'app' && out[i - 1]?.type === 'app' && out[i - 1].app === s.app));
}

export function describe(steps) {
  let app = '';
  return clean(steps).map((s, i) => {
    const where = s.app && s.app !== app ? `[${s.app}] ` : '';
    if (s.app) app = s.app;
    const n = `${i + 1}. `;
    if (s.type === 'app') return `${n}${s.app} 앱으로 전환`;
    if (s.type === 'click') return `${n}${where}${s.title ? `「${s.title}」 ` : ''}${ROLE[s.role] || s.role || '요소'} 클릭`;
    if (s.type === 'type') return `${n}${where}${s.field ? `「${s.field}」 ` : ''}입력 칸에 "${s.text}" 입력`;
    return `${n}${where}단축키 ${s.keys}`;
  }).join('\n');
}

export function save(steps, { bot = 'dec-intern' } = {}) {
  const list = clean(steps);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ bot, at: Date.now(), steps: list }, null, 1), { mode: 0o600 });
  return { file, steps: list };
}

// The message that starts the drafting chat.
export function draftPrompt(steps) {
  const text = describe(steps);
  return `내가 방금 맥에서 직접 한 작업을 단계로 기록했어. 이걸 이 봇의 루틴 초안으로 만들어 줘.\n\n${text}\n\n` +
    `- 같은 일을 다음에도 할 수 있게 단계를 짧게 정리해 줘. 각 단계에는 어느 앱의 어느 버튼·칸·메뉴인지 이름을 남겨 줘 (실행할 때 cu_look으로 찾고 cu_click/cu_type/cu_key로 해).\n` +
    `- 매번 바뀔 값(입력한 글자 같은 것)은 {이름}으로 바꿔 입력으로 빼 줘.\n- 다른 앱을 직접 조작하니 tools는 full로 해 줘.\n- 그다음 routine_save로 저장을 제안해 줘. 내가 확인하고 저장할게.`;
}
