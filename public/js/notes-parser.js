// 교사가 자유롭게 적은 메모를 문장별로 나눠 학생 이름을 찾고,
// 앞자리 필요 / 떨어뜨리기 / 가까이 앉히기 / 일반 메모로 자동 분류합니다.
// 브라우저와 Node 양쪽에서 쓰는 순수 모듈입니다 (DOM 사용 안 함).

export const KEYWORDS = {
  front: ['시력', '눈이 나', '눈 나', '눈이 안 좋', '눈이 안좋', '눈이 좋지', '안경', '앞자리', '앞 자리', '앞줄', '앞 줄', '앞에 앉', '앞쪽', '앞으로', '칠판', '잘 안 보', '잘 안보', '안 보여', '안보여', '안 보임', '안보임', '근시', '난시', '약시'],
  apart: ['싸', '다툼', '다퉈', '다투', '갈등', '사이가 안', '사이 안', '사이가 나', '사이 나', '사이가 좋지', '사이 좋지', '사이가 별로', '불화', '떨어', '분리', '멀리', '따로', '붙이면 안', '붙이지', '앉히면 안', '앉히지', '괴롭', '때리', '때렸', '왕따', '따돌', '피해', '가해', '트러블', '안 맞', '안맞', '맞지 않', '맞지않', '못 지내', '앙숙', '견제', '시비', '험담', '놀리', '놀렸', '싫어', '미워', '부딪', '충돌', '마찰', '친하지 않', '친하지않', '원수', '거리를 두', '거리 두', '같이 두면', '같은 모둠 x', '같은 모둠에 두면 안'],
  together: ['도우미', '도와주', '도움', '짝으로', '짝을', '짝꿍', '짝 지', '짝지', '짝이', '같이 앉', '함께 앉', '붙여', '가까이', '옆에', '옆자리', '친하', '친해', '잘 맞', '잘맞', '잘 지내', '챙겨', '멘토', '보살', '이끌어', '같은 모둠', '단짝', '절친', '의지'],
};

// 이 표현이 있으면 "안 좋은 사이" 판단을 취소합니다 (예: 싸우지 않음, 요즘은 잘 지냄)
const NEGATE_APART = /싸우지\s*않|안\s*싸|다투지\s*않|갈등(이|은)?\s*없|문제(가|는)?\s*없|사이(가|는)?\s*좋(다|음|아|은|고)|잘\s*지내|화해/;
// "붙여 앉히면 떠듦"처럼 같이 앉았을 때의 부정적 결과를 적은 표현 → 떨어뜨리기
const TOGETHER_IS_BAD = /(붙|같이|함께|옆|나란히|짝|가까이|모둠)[^,]{0,8}(앉히면|앉으면|두면|있으면|되면|시키면|하면|해서|앉아서|있어서)[^,]{0,24}(방해|떠들|떠듦|수다|장난|집중|산만|문제|안 됨|안됨|안 돼|안돼|곤란|힘들|어렵|위험|싸|다투)/;

const PARTICLES = '(?:이랑|랑|하고|과|와|은|는|이|가|을|를|도|의|에게|한테|께|님|양|군|이는|이가|이도|이를)?';

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')');
}

function cleanSentence(s) {
  return s.replace(/^[\s\-•*▪▫◦·o]+/, '').replace(/^\(?\d+[.)]\s*/, '').trim();
}

/** 줄 → 문장 배열. 같은 줄의 문장은 서로 이어지는 내용으로 봅니다. */
function splitLines(text) {
  return normalize(text)
    .split(/\n/)
    .map((line) => line
      .split(/(?<![0-9])[.!?;](?![0-9])|\s\/\s|·(?=\s)/)
      .map(cleanSentence)
      .filter((s) => /[가-힣A-Za-z]/.test(s)))
    .filter((line) => line.length);
}

function lastIndexOfAny(text, keywords) {
  let best = -1;
  for (const k of keywords) {
    const idx = text.lastIndexOf(k);
    if (idx > best) best = idx;
  }
  return best;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 문장에서 언급된 학생을 등장 순서대로 찾습니다. */
export function findStudents(text, students) {
  const spans = [];
  const byLen = [...students].sort((a, b) => b.name.length - a.name.length);
  for (const s of byLen) {
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(s.name, from);
      if (idx < 0) break;
      spans.push({ sid: s.id, index: idx, len: s.name.length });
      from = idx + s.name.length;
    }
  }
  // 성을 뺀 이름(예: "하늘이")으로도 찾되, 반에서 유일할 때만
  const givenMap = new Map();
  for (const s of students) {
    if (s.name.length !== 3) continue;
    const given = s.name.slice(1);
    givenMap.set(given, [...(givenMap.get(given) || []), s.id]);
  }
  for (const [given, sids] of givenMap) {
    if (sids.length !== 1 || given.length < 2) continue;
    if (students.some((s) => s.id !== sids[0] && s.name.includes(given))) continue;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(given, from);
      if (idx < 0) break;
      const overlaps = spans.some((sp) => idx < sp.index + sp.len && idx + given.length > sp.index);
      if (!overlaps) spans.push({ sid: sids[0], index: idx, len: given.length, given: true });
      from = idx + given.length;
    }
  }
  spans.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const ordered = [];
  for (const sp of spans) {
    if (seen.has(sp.sid)) continue;
    seen.add(sp.sid);
    ordered.push(sp.sid);
  }
  return { sids: ordered, spans };
}

/** 문장에서 학생 이름(과 조사)을 지운 나머지 내용 */
function stripNames(text, students, sids) {
  let out = text;
  for (const sid of sids) {
    const s = students.find((x) => x.id === sid);
    if (!s) continue;
    const names = [s.name];
    if (s.name.length === 3) names.push(s.name.slice(1));
    for (const n of names) out = out.replace(new RegExp(`${escapeRegExp(n)}${PARTICLES}`, 'g'), ' ');
  }
  return out.replace(/\s+/g, ' ').replace(/^[\s,\-–—:·↔→=]+|[\s,\-–—:·]+$/g, '').trim();
}

function classify(unit, students, sids, subjectHint) {
  const items = [];
  const text = unit.trim();
  let apartIdx = lastIndexOfAny(text, KEYWORDS.apart);
  const togetherIdx = lastIndexOfAny(text, KEYWORDS.together);
  const frontIdx = lastIndexOfAny(text, KEYWORDS.front);
  const bad = TOGETHER_IS_BAD.exec(text);
  if (bad) apartIdx = Math.max(apartIdx, bad.index + bad[0].length);
  if (NEGATE_APART.test(text) && !bad) apartIdx = -1;

  let pairType = null;
  if (apartIdx >= 0 || togetherIdx >= 0) pairType = apartIdx >= togetherIdx ? 'apart' : 'together';

  let pairMade = false;
  if (pairType && sids.length >= 2 && sids.length <= 4) {
    for (let i = 0; i < sids.length; i++) for (let j = i + 1; j < sids.length; j++) items.push({ kind: 'rule', type: pairType, a: sids[i], b: sids[j], source: text });
    pairMade = true;
  } else if (pairType && sids.length === 1 && subjectHint && subjectHint !== sids[0]) {
    items.push({ kind: 'rule', type: pairType, a: subjectHint, b: sids[0], source: text });
    pairMade = true;
  }

  if (frontIdx >= 0) {
    const targets = pairMade ? [sids[0]] : sids;
    for (const sid of targets) items.push({ kind: 'front', sid, source: text });
  }

  if (!pairMade || frontIdx >= 0) {
    const memo = sids.length === 1 ? stripNames(text, students, sids) : text;
    if (memo.length >= 2 && !(pairMade && frontIdx >= 0 && sids.length > 1)) {
      const targets = pairMade ? [sids[0]] : sids;
      for (const sid of targets) items.push({ kind: 'memo', sid, memo, source: text });
    }
  }
  return items;
}

/**
 * @param {string} text 교사가 붙여넣은 메모
 * @param {{id:string,name:string}[]} students 반 학생
 * @returns {{ items: object[], unmatched: string[] }}
 */
export function parseTeacherNotes(text, students) {
  const items = [];
  const unmatched = [];
  for (const line of splitLines(text)) {
    let prevSids = [];
    for (const sentence of line) {
    let { sids } = findStudents(sentence, students);
    if (sids.length === 0) {
      if (!prevSids.length) { unmatched.push(sentence); continue; }
      sids = prevSids; // 같은 줄에서 이름 없이 이어지는 문장은 앞 문장의 학생 이야기
    }
    prevSids = sids;

    let units = [{ text: sentence, sids }];
    if (sids.length >= 2 && sentence.includes(',')) {
      const frags = sentence.split(',').map((f) => f.trim()).filter(Boolean);
      const parsedFrags = frags.map((f) => ({ text: f, sids: findStudents(f, students).sids }));
      const selfContained = parsedFrags.every((f) => f.sids.length >= 1 && stripNames(f.text, students, f.sids).length >= 2);
      if (parsedFrags.length >= 2 && selfContained) units = parsedFrags;
    }

    let subject = null;
    for (const unit of units) {
      items.push(...classify(unit.text, students, unit.sids, subject));
      subject = unit.sids[0] || subject;
    }
    }
  }

  // 같은 두 학생 규칙은 마지막 것만, 같은 메모 중복 제거
  const ruleMap = new Map();
  const memoSeen = new Set();
  const frontSeen = new Set();
  const out = [];
  for (const it of items) {
    if (it.kind === 'rule') {
      const key = [it.a, it.b].sort().join('|');
      const prev = ruleMap.get(key);
      if (prev && prev.type === it.type) {
        if (!prev.source.includes(it.source)) prev.source = `${prev.source} / ${it.source}`;
      } else ruleMap.set(key, { ...it });
    } else if (it.kind === 'front') {
      if (frontSeen.has(it.sid)) continue;
      frontSeen.add(it.sid);
      out.push(it);
    } else if (it.kind === 'memo') {
      const key = `${it.sid}|${it.memo}`;
      if (memoSeen.has(key)) continue;
      memoSeen.add(key);
      out.push(it);
    }
  }
  return { items: [...ruleMap.values(), ...out], unmatched };
}
