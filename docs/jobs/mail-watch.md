# Watching your mail

Your mail is a website you are signed in to in Dec (Gmail, Naver, Daum, Outlook on the web), so Dec Intern reads it there, in a
background tab, and never needs the password. Copy this to `~/.config/dec-intern/jobs/mail.md`, or ask: "새 메일 오면 알려줘".
Each run keeps the newest mail it saw in `seen.txt` in its `cwd`, and stays quiet until something new arrives.

```
---
name: 새 메일
every: 15m
cwd: /Users/you/watch/mail
tools: edit
---
mcp__dec-intern__browser_task로 https://mail.naver.com/ 를 읽기만(look_only) 하고 — 받은편지함 첫 화면이면 충분해 —
이어서 mcp__dec-intern__browser_read로 그 페이지를 읽어. 안 읽은 메일의 보낸 사람·제목·시각을 위에서부터 최대 10개 뽑아.
seen.txt(없으면 새로)에 적힌 "보낸 사람 | 제목 | 시각" 줄들과 비교해서:
- 새 메일이 없으면 [조용] 만 답해.
- 새 메일이 있으면 메일마다 "보낸 사람 — 제목" 한 줄씩 말하고(광고·알림 메일은 "광고 N건"으로 묶어), 지금 본 목록을 seen.txt에 써.
로그인하라고 나오면 "메일 로그인이 필요해요" 한 줄만 말해. 본문은 열지 말고, 메일을 지우거나 보내지 마. 지어내지 마.
```

Gmail: the same with `https://mail.google.com/mail/u/0/#inbox`; Outlook: `https://outlook.live.com/mail/0/`.

**Reading and answering by hand.** In a chat, "안 읽은 메일 요약해 줘" is the same look_only task; "이 메일에 이렇게 답장 써 줘: …" is a
`browser_task` whose typing holds the reply, and the send button is a step Dec holds for you — nothing is sent until you say so,
in the approval card or in Dec itself. A job never sends: it only reads, so `tools: edit` (for `seen.txt`) is all it needs.
