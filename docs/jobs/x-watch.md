# Watching an X account

Copy one of these to `~/.config/bisu/jobs/x-<name>.md` (or ask Dec Intern: "@someone 새 글 올라오면 알려줘").
Each run keeps the last post it saw in `seen.txt` in its `cwd`, and stays quiet until there is a new one.

## Without a key: your own signed-in browser

X shows little to a fetch that is not signed in, so the run reads the profile in your Dec browser, in a background tab.

```
---
name: "@someone 새 글"
every: 30m
cwd: /Users/you/watch/x-someone
tools: edit
---
mcp__bisu__browser_task로 https://x.com/someone 를 열고, 고정된 글을 빼고 가장 최근 글 3개의 링크와 첫 줄을 읽어.
seen.txt(없으면 새로)에 적힌 링크와 비교해서:
- 새 글이 없으면 [조용] 만 답해.
- 새 글이 있으면 글마다 "첫 줄 — 링크" 한 줄씩 말하고, 가장 최근 링크를 seen.txt에 써.
로그인하라고 나오면 "X 로그인이 필요해요" 한 줄만 말해. 지어내지 마.
```

## With the X API: a key by name

Save the bearer token in Dec as `X_BEARER_TOKEN` for `https://api.x.com`. The run never sees it: dec-secret hands the
command a one-time token and `X_BEARER_BASE_URL`, and puts the key on the request on its way out. Needs `tools: full`
(it runs a command), so it waits for your approval.

```
---
name: "@someone 새 글 (API)"
every: 30m
cwd: /Users/you/watch/x-someone
tools: full
---
이 명령으로 최근 글을 가져와:
X_BEARER_TOKEN=dec://X_BEARER_TOKEN dec-secret run -- sh -c 'curl -s "$X_BEARER_BASE_URL/2/users/by/username/someone?user.fields=id" -H "Authorization: Bearer $X_BEARER_TOKEN"'
로 id를 얻고(처음 한 번, id.txt에 저장), 그다음부터는 .../2/users/<id>/tweets?max_results=5&exclude=replies,retweets 로.
seen.txt의 마지막 글 id보다 새 글이 없으면 [조용]. 있으면 글마다 첫 줄과 https://x.com/someone/status/<id> 를 한 줄씩, 그리고 가장 새 id를 seen.txt에.
오류면 상태 코드와 메시지만 한 줄로.
```

To stop: `enabled: false`, or end the body's condition with `[끝]` (for "그 사람이 X 올리면 한 번만 알려줘").
