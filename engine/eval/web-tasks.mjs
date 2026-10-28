// Web tasks on public practice sites, the same in every browser bisu can drive: success and time.
//   OPENAI_API_KEY=dec://OPENAI_API_KEY GLM_API_KEY=dec://GLM_API_KEY dec-secret run -- \
//     node engine/eval/web-tasks.mjs [--set speed|complex|hard|holdout|holdout2] [--modes dec,ego,aside,decfast] [--repeat 2] [--only O1,O2] [--budget 20]
// dec = bisu drives dec (dec's fast mode must be off); decfast = dec's own fast mode (must be on); ego, aside = bisu
// drives them. The sites are made for scraping practice (books.toscrape, quotes.toscrape, scrapethissite,
// webscraper.io, the-internet, web-scraping.dev, scrapingcourse, Oxylabs' sandbox), so repeating is fine.
// One JSON line per run on stdout; docs/web-eval.md keeps the results and what each round changed.
// "holdout" and "holdout2" were measured before anything was tuned on them; holdout's faults were then fixed, so
// only a set nobody has tuned on yet says how bisu does on unfamiliar pages.
import * as ego from '../ego.mjs';
import * as dec from '../dec.mjs';
import * as aside from '../aside.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d };
const B = 'https://books.toscrape.com/', Q = 'https://quotes.toscrape.com/', S = 'https://www.scrapethissite.com/pages/', W = 'https://webscraper.io/test-sites/e-commerce/';
const WS = 'https://web-scraping.dev/', SC = 'https://www.scrapingcourse.com/', OX = 'https://sandbox.oxylabs.io/';
const SETS = {
  speed: [
    {key: 'simple', url: B, goal: "첫 페이지에서 'A Light in the Attic' 책의 가격을 알려줘", ok: a => /51\.77/.test(a)},
    {key: 'medium', url: B, goal: "Travel 카테고리로 가서 'It's Only the Himalayas' 책을 열고 가격과 재고를 알려줘", ok: a => /45\.17/.test(a) && /19/.test(a)},
    {key: 'deep', url: B, goal: 'Mystery 카테고리의 2쪽으로 가서, 그 페이지에서 가장 비싼 책을 열고 제목·가격·재고 수량·UPC를 알려줘', ok: a => /57\.70/.test(a) && /b0913e67d38d5ed5/.test(a) && /\b1\b/.test(a) && /Ladies/i.test(a)},
  ],
  complex: [
    {key: 'C1', url: B, goal: 'Travel, Poetry, Science Fiction 세 카테고리에서 각각 가장 싼 책의 제목과 가격을 알려줘', ok: a => /23\.21/.test(a) && /14\.19/.test(a) && /10\.65/.test(a) && /Little Dribbling/i.test(a) && /Grown Women/i.test(a) && /The Project/i.test(a)},
    {key: 'C2', url: B, goal: 'Fantasy 카테고리의 모든 쪽을 확인해서, 그 카테고리 전체에서 가장 비싼 책의 제목과 가격을 알려줘', ok: a => /58\.75/.test(a) && /Myriad/i.test(a)},
    {key: 'C3', url: B, goal: 'Mystery 카테고리 1쪽에 있는 책들 중 가장 비싼 책과 가장 싼 책의 가격 차이를 알려줘', ok: a => /48\.79/.test(a)},
    {key: 'C4', url: B, goal: 'Historical Fiction 카테고리 2쪽의 첫 번째 책을 열고, 그 책의 제목·UPC·재고 수량·리뷰 수를 알려줘', ok: a => /155e42df837ee5ff/.test(a) && /Between Shades/i.test(a) && /\b3\b/.test(a) && /\b0\b/.test(a)},
    {key: 'C5', url: Q, goal: "'inspirational' 태그 페이지로 가서 첫 번째 명언을 쓴 사람의 소개(about) 페이지를 열고, 그 사람이 태어난 날짜와 장소를 알려줘", ok: a => /1879/.test(a) && /Ulm/i.test(a)},
  ],
  hard: [
    {key: 'H1', url: B, goal: 'Sequential Art 카테고리의 모든 쪽을 확인해서, 그 카테고리 전체에서 가장 싼 책 3권의 제목과 가격을 싼 순서대로 알려줘', ok: a => /10\.16/.test(a) && /10\.64/.test(a) && /10\.90?\b/.test(a) && /Patience/i.test(a) && /Maus/i.test(a) && /Adulthood/i.test(a)},
    {key: 'H2', url: B, goal: 'Fiction, Mystery, Romance 세 카테고리에서 각각 가장 비싼 책을 열어 재고 수량을 확인하고, 그 세 권 중 재고가 가장 많은 책의 제목과 재고 수량을 알려줘', ok: a => /Boar Island/i.test(a) && /\b12\b/.test(a)},
    {key: 'H3', url: B, goal: 'Poetry 카테고리에서 가장 비싼 책과 가장 싼 책을 각각 열어서, 두 책의 재고 수량 합계를 알려줘', ok: a => /\b32\b/.test(a)},
    {key: 'H4', url: Q, goal: "'love' 태그 페이지의 모든 쪽을 확인해서, 그 명언들을 쓴 사람이 중복 없이 모두 몇 명인지 알려줘", ok: a => /\b11\s*명|\b11\b[^\d]{0,20}(명|authors|people|사람)/.test(a)},
    {key: 'H5', url: B, goal: 'Travel 카테고리에 있는 책들의 평균 가격을 소수점 둘째 자리까지 계산해서 알려줘', ok: a => /39\.79/.test(a)},
  ],
  holdout: [
    {key: 'O1', url: S + 'simple/', goal: '국가 목록 페이지에서 Iceland의 수도와 인구를 알려줘', ok: a => /Reykjavik/i.test(a) && /308,?910/.test(a)},
    {key: 'O2', url: S + 'forms/', goal: '하키 팀 페이지의 검색창에 @q 를 검색해서, Boston Bruins의 1993년 시즌 승리(Wins) 수를 알려줘', inputs: {q: 'Boston'}, ok: a => /\b42\b/.test(a)},
    {key: 'O3', url: W + 'allinone', goal: 'Computers 안의 Laptops 목록으로 가서 가장 비싼 노트북의 이름과 가격, 리뷰 수를 알려줘', ok: a => /ROG Strix SCAR/i.test(a) && /1,?799/.test(a) && /\b8\b/.test(a)},
    {key: 'O4', url: W + 'static', goal: 'Computers 안의 Tablets 목록의 모든 쪽을 확인해서 가장 비싼 태블릿의 이름과 가격을 알려줘', ok: a => /iPad Air/i.test(a) && /603\.99/.test(a)},
    {key: 'O5', url: 'https://the-internet.herokuapp.com/tables', goal: 'Example 1 표에서 Due 금액이 가장 큰 사람의 이름과 그 금액을 알려줘', ok: a => /Jason/i.test(a) && /Doe/i.test(a) && /100(\.00)?/.test(a)},
    {key: 'O6', url: S + 'ajax-javascript/', goal: '2015년 영화 목록을 열어서 가장 많은 상(Awards)을 받은 영화의 제목과 수상 개수를 알려줘', ok: a => /Mad Max/i.test(a) && /\b6\b/.test(a)},
  ],
  holdout2: [
    {key: 'P1', url: WS + 'products', goal: 'products 목록의 모든 쪽을 확인해서, 전체에서 가장 비싼 상품의 이름과 가격을 알려줘', ok: a => /Hiking Boots/i.test(a) && /89[.,]99/.test(a)},
    {key: 'P2', url: WS + 'products', goal: 'Box of Chocolate Candy 상품을 열어서 브랜드(brand)와 고를 수 있는 Variants 개수를 알려줘', ok: a => /ChocoDelight/i.test(a) && /\b6\b/.test(a)},
    {key: 'P3', url: SC + 'ecommerce/', goal: '첫 페이지 상품들 중 가장 싼 상품을 열어서 그 상품의 SKU와 카테고리를 알려줘', ok: a => /24-UG06/.test(a) && /Fitness/i.test(a)},
    {key: 'P4', url: SC + 'table-parsing', goal: '상품 표에서 재고가 없는(In Stock이 No인) 상품들 중 가장 비싼 상품의 이름과 가격을 알려줘', ok: a => /Headphones/i.test(a) && /149[.,]99/.test(a)},
    {key: 'P5', url: OX + 'products', goal: '게임 목록 첫 페이지에서 가장 싼 게임의 이름과 가격을 알려줘', ok: a => /NFL 2K1/i.test(a) && /62[.,]99/.test(a)},
    {key: 'P6', url: OX + 'products', goal: 'The Legend of Zelda: Ocarina of Time 게임을 열어서 개발사(Developer)와 유형(Type)을 알려줘', ok: a => /Nintendo/i.test(a) && /single\s*-?\s*player/i.test(a)},
  ],
};
const set = arg('set', 'holdout2'), only = arg('only', ''), T = (SETS[set] || []).filter(t => !only || only.split(',').includes(t.key));
const MODES = arg('modes', 'dec,ego,aside').split(','), REPS = Number(arg('repeat', 2)), BUDGET = Number(arg('budget', 20));
let decTab = null;
async function one(mode, t, rep) {
  const inputs = t.inputs || {};
  if (mode === 'decfast') {
    const r = await dec.task({goal: t.goal, url: t.url, inputs: Object.entries(inputs).map(([name, value]) => ({name, value})), budget: BUDGET, waitMs: 240_000});
    if (r.tabId) await dec.api('POST', `/v1/tabs/${r.tabId}/close`, {agent: 'bisu'}).catch(() => {});
    return {answer: r.answer, status: r.status, steps: r.steps};
  }
  if (mode === 'ego') { const r = await ego.run({goal: t.goal, url: t.url, inputs, space: `bisu-eval-${set}-${t.key}-${rep}`, budget: BUDGET}); await ego.close(r.space).catch(() => {}); return r }
  const drv = mode === 'dec' ? dec.directDriver({tab: decTab}) : aside.driver();
  const r = await ego.drive({goal: t.goal, url: t.url, inputs, driver: drv, budget: BUDGET});
  if (mode === 'dec') decTab = drv.tabId;
  return r;
}
for (let rep = 0; rep < REPS; rep++) for (const t of T) for (const mode of MODES) {
  const t0 = Date.now(); let r;
  try { r = await one(mode, t, rep) } catch (e) { r = {status: 'error', answer: null, error: String(e.message || e).slice(0, 160)} }
  const a = String(r.answer ?? '');
  console.log(JSON.stringify({set, task: t.key, mode, rep, s: +((Date.now() - t0) / 1000).toFixed(1), pass: t.ok(a), status: r.status, steps: r.steps, glm: r.reviews?.n, why: r.reviews?.why, answer: a.slice(0, 260), error: r.error, last: r.history?.slice(-4)}));
}
if (decTab) await dec.api('POST', `/v1/tabs/${decTab}/close`, {agent: 'bisu'}).catch(() => {});
