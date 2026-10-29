# ego lite × Claude 판단자 — 2026-10-29

- 브라우저: ego lite (`hand.mjs serve ego --port 47812`)
- 판단자: Claude (Opus 5.5), 페이지 정보는 hand 서버 출력만 사용, 이동은 `do`만 사용(`goto` 없음)
- 원본 기록: `hand-ego.jsonl` (단계 수·시간은 서버의 `answer` 기록 기준, `wait`는 단계 수에 들어가지 않음)

| 과제 | 답 | 단계 | 시간 |
|---|---|---|---|
| H1 | Patience £10.16 → The Complete Maus (Maus #1-2) £10.64 → Adulthood Is a Myth: A "Sarah's Scribbles" Collection £10.90 | 9 (입력 실수 1회 포함, 단계 수 영향 없음) | 68.4초 |
| H2 | Boar Island (Anna Pigeon #19), 재고 12권 | 16 | 115.8초 |
| P1 | Hiking Boots for Outdoor Adventures, 89.99 | 7 | 81.3초 |

---

## H1 — Sequential Art 가장 싼 책 3권

행동 순서
1. `do 6` Sequential Art: 홈 왼쪽 카테고리 목록에서 바로 이동 (75권, 4쪽)
2. `do 69` next → 2쪽: 1쪽 최저가 Patience £10.16 기록 후 다음 쪽
3. `do 69` next → 3쪽: 2쪽에서 Adulthood Is a Myth £10.90, Superman £11.89 추가
4. `do 69` next → 4쪽: 3쪽에서 Fruits Basket Vol. 2 £11.64, Saga Vol. 2 £11.75 추가
5. `do 57` The Complete Maus 열기: 4쪽에서 £10.64 발견, 목록 제목이 "(Maus ..."로 잘려 있어 전체 제목 확인용
6. `do 0` Books to Scrape(홈) — **내 조작 실수**. 명령을 잘못 보내 홈으로 감(판단이 아닌 입력 실수). 원래는 back → previous ×2로 2쪽에 가려 했음
7. `do 6` Sequential Art 다시: 2쪽으로 돌아가기 위해
8. `do 69` next → 2쪽
9. `do 65` Adulthood Is a Myth 열기: 목록 제목이 "Myth: ..."로 잘려 있어 전체 제목 확인용

헷갈린 점, 브라우저 문제
- 목록의 책 제목이 "..."로 잘려서 정확한 제목을 쓰려면 상세 쪽을 열어야 함(사이트 자체 표기). 3권 중 2권을 열었고, 그만큼 단계가 늘어남.
- 2쪽 이후 꽉 찬 목록(20권)에서는 **첫 번째 책의 제목 링크가 행동 목록에 빠짐**(예: 2쪽 "Bitch Planet", Fiction 2쪽 "Eight Hundred Grapes", Fiction 3쪽 "Deception Point"). 행동 목록이 항상 [0]~[69]+메타 3개(총 73개)라서 개수 한도에 걸린 것으로 보임. 이번 과제에는 지장이 없었지만, 빠진 책을 열어야 하는 과제라면 막힘.
- 홈 화면 행동 목록에서도 카테고리 끝부분(Health, Politics, Cultural, Erotica, Crime)이 빠져 있음(같은 한도 문제로 보임). 마지막 쪽처럼 항목이 적은 쪽에서는 나타남.
- 속도: `next` 클릭이 1.4~2.4초, 카테고리 클릭이 약 0.9초.

최종 답: 1) Patience £10.16, 2) The Complete Maus (Maus #1-2) £10.64, 3) Adulthood Is a Myth: A "Sarah's Scribbles" Collection £10.90 — 9단계, 68.4초

---

## H2 — Fiction·Mystery·Romance 최고가 책 중 재고 최다

행동 순서
1. `do 11` Fiction: 65권, 4쪽
2. `do 69` next → 2쪽: 1쪽 최고가 Shtum £55.84
3. `do 69` next → 3쪽: 2쪽 최고가 The Improbability of Love £59.45
4. `do 69` next → 4쪽: 3쪽 최고가 Last One Home £59.98
5. `do 69` previous → 3쪽: 4쪽 최고가 Kitchens of the Great... £57.20이라 Fiction 최고가는 3쪽 Last One Home
6. `do 53` Last One Home (New Beginnings #1) 열기 → 재고 5
7. `do 2` Books(경로 표시 링크): 상세 쪽에는 카테고리 목록이 없어서 Books로 올라감 (이 전에 `wait`로 상세 쪽 행동 목록만 다시 확인)
8. `do 4` Mystery: 32권, 2쪽
9. `do 69` next → 2쪽: 1쪽 최고가 Boar Island £59.48
10. `do 90` previous → 1쪽: 2쪽 최고가 The No. 1 Ladies'... £57.70이라 1쪽으로 돌아감
11. `do 63` Boar Island (Anna Pigeon #19) 열기 → 재고 12
12. `do 2` Books
13. `do 9` Romance: 35권, 2쪽
14. `do 69` next → 2쪽: 1쪽 최고가 The Perfect Play £59.99
15. `do 69` previous → 1쪽: 2쪽 최고가 Listen to Me £58.99
16. `do 66` The Perfect Play (Play by Play #1) 열기 → 재고 4

헷갈린 점, 브라우저 문제
- 각 카테고리의 마지막 쪽까지 본 뒤 최고가 책이 있던 쪽으로 `previous`로 돌아가야 해서 카테고리마다 1단계씩 더 듦. 바로 그 쪽 번호로 가는 링크는 사이트에 없음.
- 상세 쪽의 "Products you recently viewed"에 이전 과제(H1)에서 본 책(Fruits Basket Vol. 2 등)이 섞여 나옴. 과제 사이에 브라우저 상태(쿠키/세션)가 이어지는 것으로 보임. 결과에는 영향 없음.
- 항목이 적은 마지막 쪽(Mystery 2쪽 등)에서는 표지 그림 링크 "(icon) index.html"과 담기 버튼까지 모두 행동 목록에 나와 목록이 94개까지 길어짐. 꽉 찬 쪽에서는 그림 링크가 빠지고 73개로 고정됨. 쪽마다 행동 번호 체계가 달라 `previous` 번호가 69/90으로 바뀜.
- 속도: `next`/`previous`가 1.4~2.5초로 가장 느림.

최종 답: Boar Island (Anna Pigeon #19), 재고 12권 (비교: Fiction 최고가 Last One Home £59.98 재고 5, Romance 최고가 The Perfect Play £59.99 재고 4) — 16단계, 115.8초

---

## P1 — web-scraping.dev products 전체 최고가

행동 순서
1. `do 21` 2쪽: 1쪽 최고가 Box of Chocolate Candy 24.99 (전체 28개, 6쪽이라고 표시)
2. `do 22` 3쪽: 2쪽 최고가 Hiking Boots for Outdoor Adventures 89.99
3. `do 23` 4쪽: 3쪽 최고가 Classic Leather Sneakers 79.99
4. `do 24` 5쪽: 4쪽 최고가 Hiking Boots 89.99(반복)
5. `do 25` `>` 클릭: 쪽 번호 링크가 1~5까지만 있어서 6쪽으로 가려 했으나 **5쪽에 그대로 머묾**. `wait`로 기다려도 5쪽
6. `do 12` 정렬을 descending으로 바꿈: 6쪽 링크가 없어서, 순서를 뒤집어 마지막 항목들을 앞쪽으로 끌어오려는 목적
7. `do 20` 내림차순 1쪽: 28~24번째 항목이 보임 → 6쪽 항목(26~28번째) = Dark Red / Teal / Red Energy Potion, 모두 4.99

헷갈린 점, 브라우저 문제
- **6쪽으로 가는 링크가 행동 목록에 없음**. 쪽 번호는 1~5만 나오고, 5쪽에서 `>`를 눌러도 이동하지 않음(사이트 자체 페이징 한계인지, 클릭 처리 문제인지는 이 서버만으로는 구분 불가). 정렬 뒤집기로 우회함.
- 내림차순 정렬이 가격이 아니라 목록 순서를 뒤집는 것인지 확인이 필요했음. 내림차순 5쪽 = 오름차순 4~8번째, 내림차순 1쪽 = 오름차순 24~28번째로 맞아떨어져서 순서 뒤집기로 판단함.
- 3쪽부터 상품이 반복됨(12개 주기로 같은 상품이 다시 나옴). 사이트 데이터 특성.
- 목록 가격에 통화 기호가 없음(89.99로만 표시). 상세 쪽은 열지 않음.
- 쪽 이동 1.4~1.7초, 정렬 선택 0.4초로 books.toscrape보다 고름.

최종 답: Hiking Boots for Outdoor Adventures, 89.99 — 7단계, 81.3초

---

## 전체 메모
- 서버는 세 과제 동안 죽지 않음, 오류(`err`) 0건.
- 고칠 만한 것: (1) 행동 목록 개수 한도(73개)로 꽉 찬 목록 쪽의 첫 번째 상품 링크와 홈의 마지막 카테고리들이 빠짐, (2) web-scraping.dev에서 6쪽 이동 수단이 목록에 없음.
- 내 실수: H1 6단계에서 의도하지 않은 `do 0`을 보냄. 다만 원래 계획한 경로(back → previous → previous → 책 열기)도 4단계라서, 실수 경로(홈 → 카테고리 → next → 책 열기)와 단계 수가 같음. H1의 9단계는 실수가 없었어도 같았을 것.
