# Dec Intern checks and improves itself, a few times a day

A scheduled job in which Dec Intern is the lead: it looks at the app as it runs and at its own code, gives each area to one
worker to scan and test, reads their reports, and then hands each area its fixes — on a branch, re-tested, never pushed, and
never the installed app. Copy this to `~/.config/dec-intern/jobs/self-check.md` (or ask: "하루 세 번 네 코드 점검해서 담당들한테
나눠 맡기고 고칠 거 고쳐 줘"), and it runs from its next tick (under the default 확인 방식 「알아서 하기」 a job needs no approval; only 「전부 물어보기」 asks
once in Settings → 예약 작업 for a job that runs commands).

```
---
name: 자기 점검
every: 8h
cwd: /Users/you/Desktop/bisu
tools: full
timeout: 60
---
너는 이 저장소(덱 인턴 자신의 코드)의 점검을 지휘해. 코드는 네가 직접 고치지 말고 담당에게 맡기고, 보고를 네가 확인해.

0) 앱 상태부터: `node engine/eval/self-check.mjs --state` (설치된 앱이 저장소와 다른지, 최근 24시간 앱 로그 오류, Dec 연결, launchd, 예약 작업 오류, 저장소가 깨끗한지).
   작업 중인 변경이 있으면(깨끗하지 않으면) 점검과 보고만 하고 고치지 마.

1) 영역을 나눠 담당 한 명씩, 같은 턴에 동시에 맡겨. 각자 자기 영역만 읽고, 고치지 말고, "문제 / 근거(파일:줄) / 제안 / 심각도(높음·중간·낮음)" 목록으로 보고하게 해:
   ① engine/ — 자체 엔진(loop, judge, tools, cli, dec, browser, keys): `node --check` 전부, `node engine/eval/jobs-check.mjs`, `node engine/eval/routes-check.mjs`, 오류 처리가 빈 곳, 키·토큰이 출력이나 환경에 새는 곳.
   ② ui/ — 서버·페이지·기억·봇·루틴·예약·마이그레이션: `node --check` 전부, 페이지 스크립트 파싱(`new Function`), API 경로와 페이지 호출의 어긋남, 옛 이름(bisu) 잔재.
   ③ mac/ — 앱 셸·헬퍼·빌드 스크립트: `DEC_INTERN_APP_DIR=/tmp/dec-intern-check sh mac/native/build.sh`로 임시 폴더에 빌드가 되는지(설치된 앱은 건드리지 말 것), Info.plist 문구, 권한 안내문.
   ④ 프롬프트·문서 — prompt.md, engine/prompt.md, agents.json, README, docs: 도구 이름이 코드와 맞는지, 서로 어긋난 설명, 빠진 기능 설명.
   ⑤ 측정 — `OPENAI_API_KEY=dec://OPENAI_API_KEY OPENROUTER_API_KEY=dec://OPENROUTER_API_KEY GLM_VIA=openrouter dec-secret run -- node engine/eval/self-check.mjs --quick --no-web` (하루 한 번, 새벽 회차에는 --quick 없이 전체). 기준보다 낮은 항목과 실패한 과제의 답·도구를 그대로 보고.

2) 보고를 모아 영역별 할 일을 정해(심각도 높은 것부터, 한 번에 작은 수정). 할 일이 하나라도 있으면 `git switch -c self-improve/<날짜-시각>`을 만들고, 영역별 담당에게 수정 브리프(파일, 무엇을, 완료 기준, 그 영역의 시험을 다시 돌리기)를 줘.
   금지: 벤치 과제·engine/eval/baseline.json·점검 스크립트를 고쳐서 통과시키기, push, 설치된 앱 재설치, 저장소 밖 파일.

3) 담당 보고를 네가 직접 확인해(바뀐 파일 읽기, 시험 재실행). 통과한 것만 커밋(메시지: 무엇이 왜 틀렸고 무엇을 바꿨는지). 못 고친 건 커밋하지 말고 `git switch main`으로 돌아와(가지는 남겨).

답: 앱 상태 한 줄, 영역별 발견(심각도 높음만 자세히), 고친 것(가지 이름·커밋), 못 고친 것과 짐작 원인. 발견도 수정도 없으면 [조용] 만.
```

Three times a day at `every: 8h`; `schedule: 0 3,11,19 * * *` picks the hours. A scan round costs little (the workers read and run
checks; the quick bench is a few cents); a round that fixes things uses the job's models (Settings → 역할별 모델), so with an
expensive one there a fixing round can cost a few dollars. The branch it leaves (`self-improve/<date>`) is yours to read, merge
and install (`dec-intern app install`); the running app never changes by itself.
