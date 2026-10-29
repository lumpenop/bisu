# Watching the Claude desktop app

Copy this to `~/.config/bisu/jobs/claude-app.md` (or ask Dec Intern: "Claude 앱 작업 멈추면 알려줘").
`claude_sessions` reads the app's own transcripts (`~/.claude/projects`), read-only, and calls each recent session
멈춤 (a usage limit, an error, interrupted, or not moving for 10 minutes mid-turn), 진행 중 or 끝남. The run keeps
what it saw in `state.txt` in its `cwd` and stays quiet until something changes. It never retries or sends anything.

```
---
name: Claude 앱 작업 지켜보기
every: 10m
cwd: /Users/you/watch/claude-app
tools: edit
---
mcp__bisu__claude_sessions (hours: 3)로 Claude 데스크톱 앱 세션들의 상태를 봐. 다시 시도하거나 메시지를 보내지는 마.
state.txt(없으면 새로)에 적힌 지난 상태(세션 id 앞 8자리와 상태)와 비교해서:
- 바뀐 게 없으면 [조용] 만 답해.
- 바뀐 세션이 있으면 세션마다 "상태 · 제목 · 이유" 한 줄씩 쉬운 말로 말해. 멈춤이면 왜 멈췄는지(한도, 오류, 승인 대기)를 꼭.
- 그리고 지금 상태를 세션마다 "id 상태" 한 줄씩 state.txt에 써.
```

To press 다시 시도 in the app as well, the job needs `cu: true` and `tools: full` (and your approval); for one session
only, add its title: `claude_sessions (title: 교회)`. End with `[끝]` for "끝나면 한 번 알려 주고 그만".
