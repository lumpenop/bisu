# Aside 판단자 = Claude (2026-10-29)

- 조작: `engine/eval/hand.mjs serve aside --port 47813`, 기록 `hand-aside.jsonl`
- 판단: Claude가 행동 목록 번호를 직접 고름(`do`만 사용, `goto`·직접 URL 없음)
- 시간·단계는 서버 `answer` 기록 기준(`wait`·`text`는 단계에 안 셈)

## H1 — Sequential Art 가장 싼 책 3권

| # | 행동 | 이유 |
|---|------|------|
| 1 | `do 6` Sequential Art | 사이드바 카테고리로 진입(75권, 4쪽) |
| – | `wait` | 2쪽에서 출력 필터를 잘못 걸어 목록 번호를 못 봐서 다시 읽음(단계 아님) |
| 2 | `do 69` next | 2쪽 가격 확인 |
| 3 | `do 69` next | 3쪽 가격 확인 |
| 4 | `do 69` next | 4쪽(마지막) 확인 — 최저 3권 확정 |
| 5 | `do 69` previous | 3위 책 전체 제목이 목록에 없어 2쪽으로 되돌아감 |
| 6 | `do 68` previous | 2쪽 도착 |
| 7 | `do 65` Adulthood Is a Myth: ... | 책 쪽을 열어 전체 제목 확인 |

- 헷갈린 점·문제:
  - 쪽 글에서 제목이 `...`로 잘림. 전체 제목은 행동 목록의 링크 이름으로 봐야 하는데, 목록이 72개 안팎에서 잘려 2쪽의 「Adulthood Is a Myth」는 잘린 링크만 남음. 그래서 2쪽으로 돌아가 책을 여느라 3단계가 더 듦.
  - 처음 쪽에서 미리 전체 제목을 적어 두지 않은 건 내 실수(필터가 목록을 걸러냄).
- 최종 답: 1) Patience £10.16, 2) The Complete Maus (Maus #1-2) £10.64, 3) Adulthood Is a Myth: A "Sarah's Scribbles" Collection £10.90
- **단계 7, 63.8초**

## H2 — Fiction·Mystery·Romance 최고가 책 중 재고 최다

| # | 행동 | 이유 |
|---|------|------|
| 1 | `do 11` Fiction | 65권, 4쪽 |
| 2–4 | `do 69` next ×3 | 2~4쪽 가격 확인(쪽별 최고 £55.84 / £59.45 / £59.98 / £57.20) |
| 5 | `do 69` previous | 최고가 Last One Home(£59.98)이 3쪽에 있어 되돌아감 |
| 6 | `do 51` Last One Home | 재고 5권 확인 |
| 7 | `do 1` Home | 책 쪽에는 다른 카테고리 링크가 없어 홈으로 |
| 8 | `do 4` Mystery | 32권, 2쪽 |
| 9 | `do 69` next | 2쪽 확인(최고 £57.70) |
| 10 | `do 69` previous | 최고가 Boar Island(£59.48)가 1쪽에 있음 |
| 11 | `do 60` Boar Island | 재고 12권 |
| 12 | `do 1` Home | 다시 홈으로 |
| 13 | `do 9` Romance | 35권, 2쪽 |
| 14 | `do 69` next | 2쪽 확인(최고 £58.99) |
| 15 | `do 69` previous | 최고가 The Perfect Play(£59.99)가 1쪽 |
| 16 | `do 64` The Perfect Play | 재고 4권 |

- 헷갈린 점·문제:
  - 최고가 책이 앞쪽에 있으면 끝까지 본 뒤 previous로 돌아가야 해서 카테고리마다 1단계씩 더 듦(총 3단계).
  - 책 상세 쪽에 사이드바가 없어 Home을 거쳐야 함(2단계).
  - 느림: Mystery 클릭 12.5초, Last One Home 클릭 4.2초, Mystery next 3.4초. 나머지는 0.3~0.6초.
- 최종 답: **Boar Island (Anna Pigeon #19), 재고 12권** (비교: Fiction Last One Home (New Beginnings #1) £59.98 재고 5, Romance The Perfect Play (Play by Play #1) £59.99 재고 4)
- **단계 16, 112.1초**

## P1 — web-scraping.dev 전체 최고가 상품

| # | 행동 | 이유 |
|---|------|------|
| 1 | `do 21` 2 | 쪽 번호 링크로 2쪽(28개, 6쪽이라고 표시) |
| 2 | `do 22` 3 | 3쪽 |
| 3 | `do 23` 4 | 4쪽 |
| 4 | `do 24` 5 | 5쪽 — 숫자 링크는 5까지만 있음 |
| 5 | `do 25` > | 6쪽으로 가려 했으나 URL이 `?page=5` 그대로 |
| – | `wait` | 늦게 바뀌는지 확인 — 그대로(단계 아님) |
| 6 | `do 23` > | 한 번 더 시도 — 역시 안 넘어감 |
| – | `text` | 글 전체 확인, 6쪽 관련 다른 링크 없음(단계 아님) |
| 7 | `do 18` 1 | 정렬 선택 상자가 목록에서 사라져서 1쪽을 다시 불러 되살림 |
| 8 | `do 12` descending | 내림차순 1쪽 = 오름차순의 마지막 5개(6쪽 3개 포함)로 6쪽 내용 확인 |

- 헷갈린 점·문제:
  - **Aside에서 `>` 링크 클릭이 동작하지 않음**(2회, 클릭은 성공으로 기록되지만 이동 없음). 6쪽으로 가는 다른 링크가 없어 정렬을 뒤집어 우회함.
  - `>` 클릭 뒤 행동 목록에서 정렬 선택 상자(`select`)가 빠지고 번호가 2칸씩 당겨짐. 쪽을 다시 불러야 돌아옴.
  - 상품 목록이 반복됨: 3~5쪽이 1~2쪽 상품(Box of Chocolate Candy, 각종 Energy Potion, Hiking Boots 등)을 되풀이. 내림차순 1쪽(Red/Teal/Dark Red Energy Potion 4.99, Box of Chocolate Candy 24.99, Cat-Ear Beanie 14.99)이 오름차순 끝과 정확히 거꾸로 맞아서, 6쪽은 Dark Red·Teal·Red Energy Potion(4.99)로 판단. 6쪽 자체는 직접 보지 못함.
  - 내림차순은 가격 순이 아니라 목록 순서를 뒤집은 것.
- 최종 답: **Hiking Boots for Outdoor Adventures, 89.99**
- **단계 8, 93.9초**

## 요약

| 과제 | 답 | 단계 | 시간 |
|------|----|------|------|
| H1 | Patience £10.16 / The Complete Maus (Maus #1-2) £10.64 / Adulthood Is a Myth: A "Sarah's Scribbles" Collection £10.90 | 7 | 63.8초 |
| H2 | Boar Island (Anna Pigeon #19), 재고 12 | 16 | 112.1초 |
| P1 | Hiking Boots for Outdoor Adventures, 89.99 | 8 | 93.9초 |

브라우저 쪽 문제:
1. web-scraping.dev의 `>` 다음 쪽 링크 클릭이 Aside에서 무시됨(이동 없음, 오류도 없음).
2. 행동 목록이 70여 개에서 잘려 긴 쪽의 전체 제목 링크 일부가 빠짐(books.toscrape 2쪽 「Adulthood Is a Myth」).
3. books.toscrape 클릭이 가끔 느림(최대 12.5초).
