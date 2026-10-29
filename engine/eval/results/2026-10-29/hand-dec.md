# Dec 브라우저 · Claude 판단 기록 (2026-10-29)

- 브라우저: Dec (빠른 모드 꺼짐, 설정 변경 없음)
- 판단자: Claude (Opus 5.5), 이동은 `hand.mjs do`로만
- 서버 기록: `engine/eval/results/2026-10-29/hand-dec.jsonl`
- 「WAITING FOR THE PERSON」: 세 과제 모두 한 번도 나오지 않음
- 브라우저 동작 시간: 클릭 1번에 0.46~0.72초, select는 1.1초. 걸린 시간 대부분은 판단(읽고 고르는) 시간

| 과제 | 답 | 단계 | 시간 |
|---|---|---|---|
| H1 | Patience £10.16 → The Complete Maus £10.64 → Adulthood Is a Myth £10.90 | 4 | 23.9초 |
| H2 | Boar Island (Anna Pigeon #19), 재고 12 | 16 | 113.0초 |
| P1 | Hiking Boots for Outdoor Adventures, 89.99 | 6 | 63.8초 |

---

## H1 · Sequential Art 가장 싼 책 3권

시작 URL `https://books.toscrape.com/`

고른 행동
1. `do 6` Sequential Art: 왼쪽 카테고리 목록에서 바로 진입. 75권, 4쪽(Page 1 of 4) 확인
2. `do 114` next: 1쪽 최저가 Patience £10.16, Princess Jellyfish £13.61 기록 후 2쪽으로
3. `do 115` next: 2쪽에서 Adulthood Is a Myth £10.90, Superman Vol. 1 £11.89 추가
4. `do 115` next: 3쪽에서 Fruits Basket Vol. 2 £11.64, Saga Vol. 2 £11.75 추가. 4쪽(마지막)에서 The Complete Maus £10.64 발견
5. `answer`: 20+20+20+15=75권 다 봄. 싼 순서 Patience → Maus → Adulthood

헷갈린 점·브라우저 문제
- 본문의 책 제목이 「Scott Pilgrim's Precious Little ...」처럼 잘려 있음. 온전한 제목은 행동 목록에만 있어서 둘을 맞춰 봐야 했음
- 「results - showing to .」에서 굵은 숫자(75, 1, 20)가 문장에서 빠져 따로 줄에 찍힘. 읽을 수는 있음
- 행동 목록 순서가 화면 순서와 다름: 책 4권 → 온전한 제목 4개 → 카테고리 17개 → 나머지 책 순서로 섞여 나옴. 목록이 117~119개로 길어 next 번호(114/115)를 매번 확인해야 했음

최종 답: 1) Patience £10.16, 2) The Complete Maus (Maus #1-2) £10.64, 3) Adulthood Is a Myth: A "Sarah's Scribbles" Collection £10.90
단계 4 · 시간 23.9초(23,852ms)

---

## H2 · Fiction·Mystery·Romance 최고가 책의 재고 비교

시작 URL `https://books.toscrape.com/`

고른 행동
1. `do 11` Fiction: 65권, 4쪽
2. `do 114` next: 1쪽 최고가 Shtum £55.84
3. `do 115` next: 2쪽 최고가 The Improbability of Love £59.45
4. `do 115` next: 3쪽 최고가 Last One Home £59.98(Digital Fortress £58.00)
5. `do 69` previous: 4쪽(5권) 최고가 Kitchens of the Great Midwest £57.20, 그래서 3쪽으로 돌아감
6. `do 50` Last One Home 열기: £59.98, In stock (5 available)
7. `do 1` Home: 책 쪽에는 카테고리 목록이 없어서 첫 화면으로
8. `do 4` Mystery: 32권, 2쪽. 1쪽 최고가 Boar Island £59.48
9. `do 114` next: 2쪽 최고가 The No. 1 Ladies' Detective Agency £57.70라 1쪽 Boar Island가 최고
10. `do 90` previous: 1쪽으로 돌아감
11. `do 96` Boar Island 열기: £59.48, In stock (12 available)
12. `do 1` Home
13. `do 9` Romance: 35권, 2쪽. 1쪽 최고가 The Perfect Play £59.99
14. `do 114` next: 2쪽 최고가 Listen to Me £58.99라 1쪽 The Perfect Play가 최고
15. `do 99` previous: 1쪽으로
16. `do 105` The Perfect Play 열기: £59.99, In stock (4 available)
17. `answer`: 재고 5 / 12 / 4라서 Boar Island

헷갈린 점·브라우저 문제
- 책 상세 쪽에는 카테고리 목록이 없고 빵부스러기(Home·Books·카테고리)만 있어서, 다른 카테고리로 갈 때마다 Home을 한 번 더 눌러야 함(2단계 추가)
- 가장 비싼 책이 마지막 쪽에 있지 않으면 previous로 되돌아가야 함(3단계 추가). 전체 16단계 중 5단계가 되돌아가기·Home
- 상세 쪽 URL이 출력과 JSONL 모두에서 `catalogue/[redacted-token]/index.html`로 가려짐. 책 주소의 slug를 토큰으로 오인한 듯함. 판단에는 지장 없지만 기록에서 어느 책인지 URL로는 알 수 없음(제목으로는 확인 가능)
- 목록 쪽 가격은 본문 순서대로 제목과 짝지어야 함. 첫 쪽에서 짝이 맞는지 확인하는 데 시간이 들었음

최종 답: Boar Island (Anna Pigeon #19), 재고 12권 (Mystery 최고가 £59.48)
- 비교: Fiction 최고가 Last One Home (New Beginnings #1) £59.98 재고 5, Romance 최고가 The Perfect Play (Play by Play #1) £59.99 재고 4

단계 16 · 시간 113.0초(112,965ms)

---

## P1 · web-scraping.dev 전체 최고가 상품

시작 URL `https://web-scraping.dev/products`

고른 행동
1. `do 18` 2쪽: 1쪽은 Box of Chocolate Candy 24.99와 포션들(4.99). 「28 results in 6 pages」 확인
2. `do 19` 3쪽: 2쪽 최고가 Hiking Boots for Outdoor Adventures 89.99
3. `do 20` 4쪽: 3쪽 최고가 Classic Leather Sneakers 79.99. 1쪽 상품이 다시 나오기 시작함
4. `do 21` 5쪽: 4쪽에도 Hiking Boots 89.99 반복
5. `do 11` 정렬을 descending으로 바꿈: 5쪽에는 `>`와 `6`이 행동 목록에 없어서 6쪽으로 갈 방법이 없었음. 내림차순으로 바꾸면 1쪽에 마지막 상품들(28~24번)이 나오므로 6쪽 내용을 확인할 수 있다고 봄
6. `do 18` 1쪽(내림차순): Red, Teal, Dark Red Energy Potion(4.99), Box of Chocolate Candy, Cat-Ear Beanie. 오름차순 5쪽 끝(Beanie, Box)과 겹쳐서 28개를 다 봤다고 판단
7. `answer`: 최고가 Hiking Boots for Outdoor Adventures 89.99

헷갈린 점·브라우저 문제
- 페이지에는 「6 pages」라고 나오는데 번호는 1~5만 있음. 5쪽에서는 본문에 `>`가 보이지만 행동 목록에는 없음(비활성 링크로 보임). 6쪽으로 바로 갈 수 없어 정렬을 뒤집는 우회가 필요했음
- 상품이 쪽마다 반복됨(서로 다른 상품은 12개뿐). 다 봤는지 판단하기 헷갈림
- 정렬 select의 행동 이름이 「select: option · option descending」으로 무엇을 정렬하는지 알 수 없음. 눌러 보니 가격순이 아니라 순서만 뒤집힘
- 정렬을 바꿔도 URL에는 order가 나타나지 않음(`?page=5` 그대로). 상태가 URL 밖에 있어 기록만으로는 재현이 어려움
- 목록 가격에 통화 기호가 없음(본문에는 숫자 89.99만 있음)

최종 답: Hiking Boots for Outdoor Adventures, 89.99
단계 6 · 시간 63.8초(63,764ms)
