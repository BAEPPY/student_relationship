// 1인 1역: 기본 역할 목록, 성향 항목, 지원서·성향 검증, 지난달 역할 조회, 현황 텍스트 가져오기
import { newId } from './tokens.js';
import { findStudents } from '../public/js/notes-parser.js';

export const DEFAULT_ROLES = [
  { id: 'broom', name: '빗자루의 마법사', subtitle: '해리포터, 헤르미온느', slots: 2, description: '친구들이 쓴 빗자루와 쓰레받기를 1. 바깥으로 튀어나오지 않고 2. 문이 잘 닫히도록 예쁘게 정리해요. (+ 복도, 교실 앞 등 쓸어야 할 순간이 생기면 솔선수범해요.)' },
  { id: 'praise', name: '칭찬 수집가', subtitle: '', slots: 2, description: '남자는 남자 반 친구들을, 여자는 여자 반 친구들의 하루를 관찰하며 한 명, 한 가지 칭찬할 일을 골라 칭찬 노트에 예쁘게 적어요. (+ 종례 시간이 되면 발표해요.) 아직 칭찬받지 않은 친구를 먼저 찾고, 실제로 본 행동을 적어요.' },
  { id: 'recorder', name: '오늘의 기록관', subtitle: '', slots: 2, description: '우리 반에서 오늘 있었던 기억할 만한 일을 골라, 나중에 누구나 읽어볼 수 있도록 교실 일기에 기록해요. 누구나 펴볼 수 있게 예쁜 글씨로 적어요. 나의 하루가 아니라 우리 반의 하루를 적고, 친구가 속상할 일은 적지 않아요.' },
  { id: 'checker', name: '꼼꼼이', subtitle: '1인 1역 도우미', slots: 2, description: '친구들이 맡은 1인 1역을 잘했는지 꼼꼼하게 확인하고, 빠뜨린 일이 있다면 친절하게 알려줘요. (+ 눈으로 보이는 청소뿐만 아니라 다른 친구들의 1인1역 역할들을 잘 알고 있어야 해요.)' },
  { id: 'desks', name: '반듯반듯 모범생', subtitle: '완벽주의자', slots: 2, description: '매일 흐트러진 책상과 의자를 살펴보고, 우리 반의 책상 줄이 반듯반듯 맞도록 정리해요. 아래 세로줄 하나를 기준으로 삼아서 책상을 맞춰요.' },
  { id: 'library', name: '도서관 사서 선생님', subtitle: '', slots: 2, description: '우리 반 책을 친구들이 편하게 읽을 수 있도록 정리하고, 매일매일 책장 밑과 위를 먼지가 없도록 닦고 쓸어요. (+ 책장 위 연필꽂이, 테이프, 가위통도 함께 봐주세요.)' },
  { id: 'lunch', name: '함냠냠 급식핑', subtitle: '', slots: 2, description: '급식 시간이 되면 친구들이 차례대로 안전하고 청결하게 급식을 받을 수 있도록 줄을 정리해요. 떠들지 말라고 명령하지 않아요. 점프, 뛰는 등 과격한 장난을 치는 친구들에게 하지 말라고 정중히 말해요.' },
  { id: 'announcer', name: '오늘의 아나운서', subtitle: '', slots: 1, description: '아침마다 오늘의 날짜와 시간표, 급식, 날씨 등 친구들이 알면 좋을 소식들을 칠판에 정리해요. (1분단 제일 앞, 오른쪽에 앉아요)' },
  { id: 'pe', name: '체육 부장님', subtitle: '', slots: 2, description: '체육 시간에 필요한 준비를 돕고, 친구들이 즐겁고 안전하게 체육 활동을 할 수 있도록 도와요.' },
  { id: 'milk', name: '우유배달 왔소', subtitle: 'cow', slots: 2, description: '아침마다 우리 반 우유와 두유를 가져와 친구들에게 나누어 주고, 남은 우유와 우유 상자를 정리해요. (아침에 일찍 와서 같이 싸우지 말고 다녀옵니다.)' },
  { id: 'notes', name: '참 잘했어요', subtitle: '배움 노트 검사자', slots: 2, description: '우선 자기 자신의 배움노트를 빠짐 없이 잘 정리해요. 그리고 친구들이 배움 노트를 빠뜨리지 않고 잘 썼는지 확인하고, 확인한 노트에 도장을 찍어 줘요.' },
  { id: 'chromebook', name: '종이와 크롬북의 마스터', subtitle: '', slots: 2, description: '유인물을 친구들에게 나누어 주고, 크롬북을 사용한 뒤 빠진 것 없이 제자리에 잘 정리되었는지 확인해요. (이어폰, 마우스 케이스 뚜껑도 잘 닫아주세요.) 크롬북을 쓸 때 맨 먼저 가져가요.' },
  { id: 'rainbow', name: '친구를 도와주는 무지개 마법 소녀', subtitle: '', slots: 1, description: '색연필과 여러 가지 학습 도구를 가지런히 정리하고, 빠진 1인 1역이 있으면 친구를 대신해 그 일을 도와줘요.' },
  { id: 'locker', name: '사물함과 복도의 수호자', subtitle: '', slots: 1, description: '매일 사물함 위를 깨끗하게 닦고, 복도의 보드게임과 우리 반 물건들이 흐트러지지 않도록 제자리에 정리해요. (특히 탁구채, 탁구공)' },
  { id: 'door', name: 'Door Master', subtitle: '도어 매스털', slots: 1, description: '교실을 이동하거나 하루를 마칠 때 불을 끄고 문이 잘 닫혔는지 확인하고, 쉬는 시간에는 창문을 열어 교실을 환기해요. (1분단 제일 뒤, 오른쪽에 앉아요)' },
];

// 선생님의 1인 1역 선정 기준 (지원서에 적힌 내용)
export const SELECTION_CRITERIA = [
  '이 친구가 역할에 대해 잘 이해하고 있는지? (전혀 다른 이유를 적는 친구들이 많아요)',
  '자신이 하고 싶은 이유와 자신에게 도움 되는 이유를 성의껏 작성하였는지? (1순위로 되는 친구들은 이유를 평균 3줄 이상 적어냅니다)',
  '이전 활동을 열심히 한 친구인지?',
  '해당 역할에 너무 많은 지원자가 몰리진 않았는지? (모든 역할이 소중하므로, 인기 있어 보이는 역할만 지원하면 곤란해요)',
];

export const TRAITS = [
  { id: 'quiet', label: '조용한 편이다' },
  { id: 'talkative', label: '말이 많은 편이다' },
  { id: 'playful', label: '장난기가 많은 편이다' },
  { id: 'active', label: '활발한 편이다' },
  { id: 'shy', label: '낯을 조금 가리는 편이다' },
  { id: 'initiates', label: '친구에게 먼저 말을 잘 거는 편이다' },
  { id: 'warmsUp', label: '친해지면 말을 많이 하는 편이다' },
  { id: 'soloFocus', label: '혼자 집중하는 것을 좋아한다' },
  { id: 'talkWhileWork', label: '친구와 이야기하며 하는 것을 좋아한다' },
  { id: 'focused', label: '수업시간에 집중을 잘하는 편이다' },
  { id: 'daydream', label: '수업시간에 딴생각을 자주 하는 편이다' },
  { id: 'chatty', label: '옆 친구와 이야기를 자주 하는 편이다' },
  { id: 'responds', label: '친구가 말을 걸면 같이 이야기하게 되는 편이다' },
  { id: 'tidy', label: '정리정돈을 잘하는 편이다' },
  { id: 'forgetful', label: '물건을 자주 잃어버리거나 깜빡하는 편이다' },
  { id: 'asks', label: '모르는 것이 있으면 친구에게 잘 물어본다' },
  { id: 'teaches', label: '친구가 모르는 것을 잘 알려주는 편이다' },
  { id: 'yields', label: '먼저 양보하는 편이다' },
  { id: 'assertive', label: '내 의견을 분명하게 말하는 편이다' },
  { id: 'listens', label: '친구의 의견을 잘 들어주는 편이다' },
  { id: 'friendly', label: '새로운 친구와도 금방 친해지는 편이다' },
];
const traitIds = new Set(TRAITS.map((t) => t.id));

const LIMITS = { roleName: 40, roleSubtitle: 40, roleDesc: 600, roles: 40, slots: 10, reason: 600, partnerText: 300 };
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const bad = (m) => new ValidationError(m);

/** 교사가 보낸 역할 목록을 정리합니다. */
export function normalizeRoles(input) {
  if (!Array.isArray(input)) throw bad('역할 목록이 올바르지 않아요.');
  if (input.length > LIMITS.roles) throw bad(`역할은 ${LIMITS.roles}개까지 만들 수 있어요.`);
  const ids = new Set();
  const names = new Set();
  return input.map((r) => {
    const name = String(r?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw bad('이름이 없는 역할이 있어요.');
    if (name.length > LIMITS.roleName) throw bad(`역할 이름은 ${LIMITS.roleName}자 이하로 적어 주세요: ${name.slice(0, 10)}…`);
    if (names.has(name)) throw bad(`같은 이름의 역할이 두 개 있어요: ${name}`);
    names.add(name);
    const slots = Number.parseInt(r?.slots, 10);
    if (!(slots >= 1 && slots <= LIMITS.slots)) throw bad(`${name}의 인원은 1~${LIMITS.slots} 사이여야 해요.`);
    let id = typeof r?.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(r.id) && !RESERVED_IDS.has(r.id) ? r.id : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    return {
      id,
      name,
      subtitle: String(r?.subtitle ?? '').trim().slice(0, LIMITS.roleSubtitle),
      slots,
      description: String(r?.description ?? '').trim().slice(0, LIMITS.roleDesc),
    };
  });
}

export function roomRoles(room) {
  return Array.isArray(room.roles) ? room.roles : [];
}

/** "2026년 10월" → 2026*12+9 (비교용). 못 읽으면 null */
export function monthIndex(name) {
  const m = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String(name || ''));
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

/**
 * 어떤 회차(달) 바로 전 달의 배정 기록을 찾습니다.
 * - 회차 이름이 "YYYY년 M월" 꼴이면: 그보다 앞선 달 가운데 가장 가까운 달 (같은 달 기록이 여럿이면 가장 최근에 저장한 것).
 *   앞선 달이 없으면, 달 이름을 읽을 수 없는 기록 중 가장 최근 것만 후보로 봅니다. (뒤 달의 기록을 '지난달'로 쓰지 않음)
 * - 회차 이름을 읽을 수 없으면: 이 회차의 기록이 아닌 것 중 가장 최근 기록.
 */
export function previousHistoryFor(room, round) {
  const history = Array.isArray(room.roleHistory) ? room.roleHistory : [];
  if (!history.length) return null;
  const notMine = history.filter((h) => h.month !== round?.name && (!h.roundId || !round?.id || h.roundId !== round.id));
  const cur = monthIndex(round?.name);
  const stamp = (h) => String(h.updatedAt || '');
  if (cur !== null) {
    const dated = notMine.map((h) => ({ h, idx: monthIndex(h.month) }));
    const before = dated.filter((x) => x.idx !== null && x.idx < cur).sort((a, b) => (b.idx - a.idx) || stamp(b.h).localeCompare(stamp(a.h)));
    if (before.length) return before[0].h;
    const undated = dated.filter((x) => x.idx === null);
    return undated.length ? undated[undated.length - 1].h : null;
  }
  return notMine.length ? notMine[notMine.length - 1] : null;
}

/** 학생별로 지난달에 맡았던 역할 id 목록 (같은 역할 연속 금지 규칙용) */
export function previousRoleIds(room, round) {
  const prev = previousHistoryFor(room, round);
  const out = {};
  if (!prev) return { month: null, byStudent: out };
  for (const [roleId, sids] of Object.entries(prev.assignments || {})) {
    for (const sid of sids || []) (out[sid] ||= []).push(roleId);
  }
  return { month: prev.month, byStudent: out };
}

/**
 * "역할명 ... 8 이준영 24 임민호" 처럼 적힌 현황 텍스트를 읽어 배정표로 바꿉니다.
 * 역할은 이름이 포함되는지로, 학생은 반 명단 이름으로 찾습니다.
 */
export function parseHistoryText(text, students, roles) {
  const assignments = {};
  const unmatched = [];
  const lines = String(text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  let currentRole = null;
  const roleByLine = (line) => {
    const lower = line.replace(/\s+/g, '');
    let best = null;
    for (const r of roles) {
      const key = r.name.replace(/\s+/g, '');
      const short = key.slice(0, Math.min(key.length, 4));
      if (lower.includes(key) || (short.length >= 3 && lower.includes(short))) {
        if (!best || key.length > best.name.replace(/\s+/g, '').length) best = r;
      }
    }
    return best;
  };
  for (const line of lines) {
    // "아직 배정 안 됨: 6 강서준" 같은 미배정 줄의 이름은 어느 역할에도 넣지 않습니다.
    if (/미배정|배정\s*안\s*됨|배정되지\s*않/.test(line)) { currentRole = null; continue; }
    const role = roleByLine(line);
    if (role) currentRole = role;
    const { sids } = findStudents(line, students);
    if (sids.length) {
      if (!currentRole) { unmatched.push({ line, reason: '어느 역할인지 알 수 없어요' }); continue; }
      for (const sid of sids) {
        for (const list of Object.values(assignments)) { const i = list.indexOf(sid); if (i >= 0) list.splice(i, 1); }
        (assignments[currentRole.id] ||= []).push(sid);
      }
    } else if (!role && /[가-힣]{2,}/.test(line) && !/^(역할명|번호|시간)/.test(line)) {
      unmatched.push({ line, reason: '반 명단에서 이름을 찾지 못했어요' });
    }
  }
  return { assignments, unmatched };
}

export function validateProfile(input) {
  const traits = [...new Set((Array.isArray(input?.traits) ? input.traits : []).map(String))];
  for (const t of traits) if (!traitIds.has(t)) throw bad('성향 항목이 올바르지 않아요.');
  const partnerTraits = [...new Set((Array.isArray(input?.partnerTraits) ? input.partnerTraits : []).map(String))];
  for (const t of partnerTraits) if (!traitIds.has(t)) throw bad('짝 희망 항목이 올바르지 않아요.');
  if (partnerTraits.length > 3) throw bad('내 짝에게 바라는 점은 3개까지만 고를 수 있어요.');
  const partnerText = String(input?.partnerText ?? '').trim();
  if (partnerText.length > LIMITS.partnerText) throw bad(`짝에 대한 생각은 ${LIMITS.partnerText}자 이하로 적어 주세요.`);
  return { traits, partnerTraits, partnerText };
}

/** 지원서 검증: 1지망 필수(이유 10자 이상), 역할 중복 금지, 지난달 역할 금지 */
export function validateApplication(input, roles, excludedRoleIds = []) {
  const raw = Array.isArray(input?.choices) ? input.choices.slice(0, 3) : [];
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const excluded = new Set(excludedRoleIds);
  const seen = new Set();
  const choices = [];
  raw.forEach((c, i) => {
    const roleId = String(c?.roleId ?? '');
    if (!roleId) { if (i === 0) throw bad('1지망 역할을 골라 주세요.'); return; }
    const role = roleMap.get(roleId);
    if (!role) throw bad('없는 역할이 포함되어 있어요.');
    if (excluded.has(roleId)) throw bad(`${role.name}은(는) 지난달에 맡았던 역할이라 이번 달에는 지원할 수 없어요.`);
    if (seen.has(roleId)) throw bad(`${role.name}이(가) 두 번 들어 있어요. 지망마다 다른 역할을 골라 주세요.`);
    seen.add(roleId);
    const reason = String(c?.reason ?? '').trim();
    const helpClass = String(c?.helpClass ?? '').trim();
    const helpSelf = String(c?.helpSelf ?? '').trim();
    for (const [v, label] of [[reason, '하고 싶은 이유'], [helpClass, '우리 반에 도움 되는 점'], [helpSelf, '나에게 도움 되는 점']]) {
      if (v.length > LIMITS.reason) throw bad(`${label}은(는) ${LIMITS.reason}자 이하로 적어 주세요.`);
    }
    if (reason.length < 10) throw bad(`${i + 1}지망 ${role.name}: 하고 싶은 이유를 10자 이상 적어 주세요.`);
    choices.push({ roleId, reason, helpClass, helpSelf });
  });
  if (!choices.length) throw bad('1지망 역할을 골라 주세요.');
  return { choices };
}

/** 지원 현황 집계: 역할별 지원자 수(지망별) */
export function applicantCounts(roles, applications) {
  const counts = Object.fromEntries(roles.map((r) => [r.id, { first: 0, second: 0, third: 0, total: 0 }]));
  for (const app of Object.values(applications || {})) {
    (app.choices || []).forEach((c, i) => {
      const row = counts[c.roleId];
      if (!row) return;
      row[['first', 'second', 'third'][i]]++;
      row.total++;
    });
  }
  return counts;
}

/** 9월 현황 문서의 번호·이름 (체험용/참고용). 반 명단에 같은 이름이 있으면 바로 쓸 수 있습니다. */
export const SAMPLE_SEPTEMBER = `빗자루의 마법사: 8 이준영 24 임민호
칭찬 수집가: 9 정서원 23 이지민
오늘의 기록관: 6 오지윤 26 정선우
꼼꼼이: 7 이안나 17 김규현
반듯반듯 모범생: 2 김채랑 11 최은우
도서관 사서 선생님: 1 고가현 4 양세경
함냠냠 급식핑: 3 문지율 21 안준휘
오늘의 아나운서: 20 박한음
체육 부장님: 10 지성은 18 김지환
우유배달 왔소: 13 한승연 22 오도준
참 잘했어요: 14 현서인 25 정도겸
종이와 크롬북의 마스터: 15 강채범 19 문준하
친구를 도와주는 무지개 마법 소녀: 12 한가윤
사물함과 복도의 수호자: 5 양세희
Door Master: 16 고주성`;
