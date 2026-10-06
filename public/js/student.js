import { api, el, svgEl, toast, TYPE_LABEL, TYPE_ICON, avatarColor, mascotSvg } from './common.js';

const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const app = document.getElementById('app');

let data = null;            // 서버에서 받은 원본
let draft = {};             // 편집 중인 관계 { toId: { type, tags, reason } }
let dirty = false;          // 관계 지도에 제출하지 않은 변경이 있는지

// ---------- 단계(①성향 → ②1인1역 지원 → ③친구 관계 지도) ----------
let step = 'profile';       // 'profile' | 'application' | 'relations'
let profileDraft = { traits: new Set(), partnerTraits: new Set(), partnerText: '', body: {} };
let profileDirty = false;
let appDraft = [];          // [{ roleId, reason, helpClass, helpSelf }] × 3 (1·2·3지망)
let appDirty = false;
let appErrors = {};         // { [지망 index]: { role?: msg, reason?: msg } }
let stepError = null;       // 저장/검증 오류 (말풍선에 표시)

const PARTNER_MAX = 3;      // 짝에게 바라는 점은 3개까지
const REASON_MIN = 10;      // 하고 싶은 이유 최소 글자 수
const TEXT_MAX = 600;       // 지원서 글 최대 글자 수 (서버와 동일)
const PARTNER_TEXT_MAX = 300;

const STEP_LABEL = { profile: '나는 이런 편이에요', application: '1인 1역 지원', relations: '친구 관계 지도' };
// 선생님의 선정 기준(data.selectionCriteria)을 어린이 말로 바꾼 것. 순서가 같을 때만 쓰고, 아니면 원문을 보여 줍니다.
const KID_CRITERIA = [
  '그 역할이 어떤 일을 하는지 잘 알고 있는지 봐. (역할과 상관없는 이유를 쓰면 안 돼!)',
  '하고 싶은 이유와 나에게 도움 되는 점을 정성껏 썼는지 봐. (1지망에 뽑힌 친구들은 보통 3줄 넘게 써!)',
  '지난 역할을 열심히 했는지 봐.',
  '한 역할에 너무 많은 친구가 몰리지 않았는지 봐. (모든 역할이 소중해. 인기 있어 보이는 역할만 고르면 곤란해!)',
];

// ---------- 한국어 조사 ----------
function josa(word, [a, b]) {
  const ch = word[word.length - 1] || '';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? b : a;
  return `${a}(${b})`;
}

// ---------- 유효성 ----------
function relationValid(r) {
  if (!r) return true;
  if (r.type === 'bad') return Boolean(r.reason && r.reason.trim().length >= 2); // 안 좋은 사이는 직접 쓴 이유가 꼭 필요
  return true;
}
function selectedCount() { return Object.keys(draft).length; }
function countOf(type) { return Object.values(draft).filter((r) => r.type === type).length; }
function mins() { return { good: data.room.minGood ?? 0, bad: data.room.minBad ?? 0 }; }
function minsMet() { const m = mins(); return countOf('good') >= m.good && countOf('bad') >= m.bad; }
function invalidNames() {
  return Object.entries(draft).filter(([, r]) => !relationValid(r)).map(([id]) => nameOf(id));
}
function nameOf(id) { return data.classmates.find((c) => c.id === id)?.name || '?'; }
function canSubmit() { return minsMet() && invalidNames().length === 0 && !data.room.locked; }

// ---------- 단계 상태 ----------
function stepList() {
  const list = ['profile'];
  if (data.room.rolesEnabled) list.push('application');
  list.push('relations');
  return list;
}
function stepDone(id) {
  if (id === 'profile') return Boolean(data.profile);
  if (id === 'application') return Boolean(data.application) && !applicationStale();
  return Boolean(data.submittedAt);
}

// ---------- 지원서의 역할이 아직 유효한지 ----------
// 선생님이 역할 목록을 바꾸거나(없어진 역할), 지난달 기록을 올려서(지난달에 했던 역할) 더는 고를 수 없게 된 역할
function staleKind(roleId) {
  if (!roleId) return null;
  if (!(data.roles || []).some((r) => r.id === roleId)) return 'missing';
  if ((data.excludedRoleIds || []).includes(roleId)) return 'excluded';
  return null;
}
function applicationStale() {
  return (data.application?.choices || []).some((c) => staleKind(c?.roleId));
}
// 초안에서 더는 고를 수 없는 역할을 비웁니다(쓴 글은 그대로). 비운 칸이 있으면 true
function dropStaleChoices(list) {
  let changed = false;
  for (const c of list) {
    const kind = staleKind(c.roleId);
    if (kind) { c.roleId = ''; c.stale = kind; changed = true; }
  }
  return changed;
}
function staleText(kind) {
  if (data.room.locked) return kind === 'excluded' ? '지난달에 했던 역할이라 이 지망은 비게 됐어.' : '선생님이 역할 목록을 바꿔서 이 지망은 비게 됐어.';
  return kind === 'excluded' ? '지난달에 했던 역할이라 다시 골라 줘.' : '선생님이 역할 목록을 바꿨어. 다시 골라 줘.';
}
function firstIncompleteStep() {
  const list = stepList();
  return list.find((s) => !stepDone(s)) || list[list.length - 1];
}
function neighborStep(dir) {
  const list = stepList();
  return list[list.indexOf(step) + dir] || null;
}
function goTo(id) {
  step = stepList().includes(id) ? id : stepList()[0];
  stepError = null;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function initDrafts(which = 'all') {
  if (which === 'all' || which === 'profile') {
    const p = data.profile;
    profileDraft = { traits: new Set(p?.traits || []), partnerTraits: new Set((p?.partnerTraits || []).slice(0, PARTNER_MAX)), partnerText: p?.partnerText || '', body: { ...(data.me?.body || {}) } };
    profileDirty = false;
  }
  if (which === 'all' || which === 'application') {
    const ch = data.application?.choices || [];
    appDraft = [0, 1, 2].map((i) => ({ roleId: ch[i]?.roleId || '', reason: ch[i]?.reason || '', helpClass: ch[i]?.helpClass || '', helpSelf: ch[i]?.helpSelf || '', stale: null }));
    // 더는 고를 수 없는 역할이 들어 있으면 그 칸만 비우고(쓴 글은 남김) 다시 내야 하는 상태로
    appDirty = dropStaleChoices(appDraft) && !data.room.locked;
    appErrors = {};
  }
}
// 마감되었거나(403) 새 회차가 시작됨(409) → 최신 상태로 다시 불러오되, 쓰던 내용은 지키기
function roundChangedText(status) {
  if (status === 403) return '선생님이 이번 조사를 마감했어. 지금까지 쓴 내용은 그대로 두었으니, 선생님이 다시 열면 저장할 수 있어.';
  return '선생님이 새 조사를 시작했어. 지금까지 쓴 내용은 그대로 두었으니 다시 저장해 줘!';
}
async function reloadAfterRoundChange(status) {
  try {
    data = await api(`/api/student/${encodeURIComponent(token)}`);
    draft = JSON.parse(JSON.stringify(data.relations || {}));
    dirty = false;
    // ①②에서 고치던 내용(profileDraft/appDraft)과 수정 표시는 그대로 두고, 손대지 않은 것만 서버 상태로 맞춤
    if (!profileDirty) initDrafts('profile');
    if (!appDirty) initDrafts('application');
    else dropStaleChoices(appDraft);
    stepError = roundChangedText(status);
    render();
  } catch { /* ignore */ }
}
// 다시 그릴 때 키보드 포커스가 사라지지 않도록: 포커스된 요소를 data 속성으로 기억했다가 새 요소로 되돌려 줍니다.
function redrawKeepingFocus(box, redraw) {
  const active = document.activeElement;
  let selector = null;
  let fallback = null;
  if (active && box.contains(active)) {
    const parts = Object.entries(active.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}="${CSS.escape(v)}"]`);
    if (parts.length) selector = active.tagName.toLowerCase() + parts.join('');
    if (active.dataset.slot !== undefined) fallback = `select[data-slot="${CSS.escape(active.dataset.slot)}"]`; // 예: '빼기' 버튼이 사라지면 그 칸의 선택 상자로
  }
  redraw();
  if (!selector) return;
  const next = box.querySelector(selector) || (fallback ? box.querySelector(fallback) : null);
  if (next && !next.disabled) next.focus({ preventScroll: true });
}
function lockedText() {
  return `${data.round?.name || '이번'} 조사가 끝났어. 내가 표시한 내용을 확인만 할 수 있고, 선생님이 다음 조사를 시작하면 다시 표시할 수 있어.`;
}

// ---------- 화면 ----------
function render() {
  const { me, room } = data;
  app.replaceChildren();
  document.getElementById('room-name').textContent = room.name;
  document.title = `${me.name}의 친구 관계 지도 · ${data.round?.name || ''}`;
  if (!stepList().includes(step)) step = stepList()[0];

  if (data.assignedRole) app.append(roleBanner(data.assignedRole));
  app.append(stepper());
  if (step === 'profile') renderProfile();
  else if (step === 'application') renderApplication();
  else renderRelations();
}

// 선생님이 발표한 이번 달 내 역할 (모든 단계에서 보임)
function roleBanner(role) {
  return el('section', { class: 'role-banner', role: 'status' }, [
    el('div', { class: 'party', 'aria-hidden': 'true', text: '🎉' }),
    el('div', { class: 'role-banner-body' }, [
      el('div', { class: 'role-kicker', text: `${data.round?.name || '이번 달'} 1인 1역 발표` }),
      el('h2', { text: `🎉 이번 달 내 역할: ${role.name}` }),
      role.subtitle ? el('div', { class: 'role-sub', text: role.subtitle }) : null,
      role.description ? el('p', { text: role.description }) : null,
    ]),
  ]);
}

function stepper() {
  const list = stepList();
  return el('nav', { class: 'stepper', 'aria-label': '진행 단계' }, list.map((id, i) => {
    const done = stepDone(id);
    const active = id === step;
    return el('button', {
      type: 'button',
      class: `step-pill ${active ? 'active' : ''} ${done ? 'done' : ''}`,
      'aria-current': active ? 'step' : null,
      dataset: { step: id },
      onClick: () => { if (!active) goTo(id); },
    }, [
      el('span', { class: 'n', text: done ? '✓' : String(i + 1) }),
      el('span', { class: 'lbl', text: STEP_LABEL[id] }),
    ]);
  }));
}

// 이전 / 다음(저장) 버튼 줄
function stepNav(onSave, saveLabel) {
  const prev = neighborStep(-1);
  const next = neighborStep(1);
  let nextBtn = null;
  if (next) {
    nextBtn = data.room.locked || !onSave
      ? el('button', { type: 'button', class: 'btn primary', text: '다음 ▶', onClick: () => goTo(next) })
      : el('button', { type: 'button', class: 'btn primary', text: saveLabel, onClick: onSave });
  }
  return el('div', { class: 'step-nav' }, [
    prev ? el('button', { type: 'button', class: 'btn', text: '◀ 이전', onClick: () => goTo(prev) }) : el('span'),
    nextBtn,
  ]);
}

// 인사 카드 (①②단계용: 마스코트 + 말풍선)
function helloCard(intro, bubble) {
  const sp = el('div', { class: `speech ${stepError ? 'oops' : ''}`, text: stepError || bubble });
  const card = el('section', { class: 'card hello-card' }, [
    el('div', { class: 'mascot', 'aria-hidden': 'true', html: mascotSvg({ size: 96 }) }),
    el('div', {}, [
      el('div', { class: 'badge blue', style: { marginBottom: '6px' }, text: `${data.round?.name || ''} 조사` }),
      el('h1', { text: `${data.me.name}, 안녕! 👋` }),
      el('p', { style: { marginBottom: '4px' }, text: intro }),
      sp,
    ]),
  ]);
  return {
    card,
    setBubble(text, kind = '') { sp.textContent = text; sp.className = `speech ${kind}`; },
    showError(msg) { stepError = msg; this.setBubble(msg, 'oops'); },
  };
}

function noticeCard(extra) {
  return el('section', { class: 'card', style: { padding: '14px 18px' } }, [
    el('div', { class: 'alert info', style: { margin: 0 } }, ['🔒 여기에 쓴 내용은 나만 볼 수 있어. 친구들은 볼 수 없고, 선생님만 확인해. 솔직하게 써 줘!']),
    data.room.locked ? el('div', { class: 'alert warn', style: { margin: '10px 0 0' }, text: lockedText() }) : null,
    extra || null,
  ]);
}

// ---------- ① 나는 이런 편이에요 ----------
function profileBubble() {
  if (data.room.locked) return '조사가 끝났어요!';
  if (profileDraft.traits.size === 0) return '나는 어떤 편인지 골라 줘!';
  if (profileDraft.partnerTraits.size === 0) return '내 짝은 어떤 친구면 좋을까?';
  if (data.profile && !profileDirty) return '저장 완료! 다음으로 가 볼까?';
  return '좋아! 저장하고 다음으로 가자';
}

function renderProfile() {
  const locked = data.room.locked;
  const pd = profileDraft;
  const traits = data.traits || [];
  const hello = helloCard('먼저 나에 대해 알려 줘. 선생님이 짝과 자리를 정할 때 참고할 거야.', profileBubble());
  app.append(hello.card);
  app.append(noticeCard(data.profile && !locked ? el('div', { class: 'alert success', style: { margin: '10px 0 0' }, text: '저장 완료! 끝나기 전까지는 언제든 바꾸고 다시 저장할 수 있어.' }) : null));

  // ① 나의 성향
  // 칩은 한 번만 만들고, 누르면 그 칩만 제자리에서 바꿉니다 (다시 그리면 키보드 포커스가 사라지므로)
  const traitCount = el('span', { class: 'badge gray', text: `${pd.traits.size}개 골랐어` });
  const traitBox = el('div', { class: 'trait-chips', role: 'group', 'aria-label': '나는 이런 편이에요' }, traits.map((t) => {
    const chip = el('button', {
      type: 'button',
      class: `trait-chip ${pd.traits.has(t.id) ? 'selected' : ''}`,
      'aria-pressed': pd.traits.has(t.id) ? 'true' : 'false',
      disabled: locked ? true : null,
      dataset: { trait: t.id },
      text: t.label,
      onClick: () => {
        const on = !pd.traits.has(t.id);
        if (on) pd.traits.add(t.id); else pd.traits.delete(t.id);
        chip.classList.toggle('selected', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        traitCount.textContent = `${pd.traits.size}개 골랐어`;
        profileDirty = true; stepError = null;
        hello.setBubble(profileBubble());
      },
    });
    return chip;
  }));
  app.append(el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '① 나는 이런 편이에요' }), traitCount]),
    el('p', { class: 'muted', text: '해당하는 것 모두 체크해 줘. 정답은 없어!' }),
    traitBox,
  ]));

  // ② 몸 특징 (자리 배정 참고): 항목마다 하나만 고르고, 고른 걸 다시 누르면 취소
  const bodyTraits = data.bodyTraits || [];
  const bodyRows = bodyTraits.map((t) => {
    const chips = t.options.map((o) => el('button', {
      type: 'button',
      class: `trait-chip body ${pd.body[t.id] === o.id ? 'selected' : ''}`,
      role: 'radio',
      'aria-checked': pd.body[t.id] === o.id ? 'true' : 'false',
      disabled: locked ? true : null,
      dataset: { body: t.id, option: o.id },
      text: o.label,
      onClick: () => {
        if (pd.body[t.id] === o.id) delete pd.body[t.id]; else pd.body[t.id] = o.id;
        chips.forEach((chip, i) => {
          const on = pd.body[t.id] === t.options[i].id;
          chip.classList.toggle('selected', on);
          chip.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        profileDirty = true; stepError = null;
        hello.setBubble(profileBubble());
      },
    }));
    return el('div', { class: 'body-row', role: 'radiogroup', 'aria-label': t.label }, [
      el('div', { class: 'body-label' }, [el('b', { text: t.label }), t.hint ? el('span', { class: 'muted body-hint', text: t.hint }) : null]),
      el('div', { class: 'trait-chips' }, chips),
    ]);
  });
  if (bodyRows.length) {
    app.append(el('section', { class: 'card', id: 'body-card' }, [
      el('div', { class: 'card-title' }, [el('h2', { text: '② 참고해 주세요' })]),
      el('p', { class: 'muted', text: '선생님이 자리를 정할 때 참고할게. 해당하는 게 없으면 "보통이에요"를 고르거나 비워 둬도 돼.' }),
      ...bodyRows,
    ]));
  }

  // ③ 짝에게 바라는 점 (3개까지)
  const counter = el('span', { class: 'pick-counter', id: 'partner-count' });
  const partnerChips = traits.map((t) => el('button', {
    type: 'button',
    class: 'trait-chip partner',
    dataset: { partner: t.id },
    text: t.label,
    onClick: () => {
      if (pd.partnerTraits.has(t.id)) pd.partnerTraits.delete(t.id);
      else if (pd.partnerTraits.size < PARTNER_MAX) pd.partnerTraits.add(t.id);
      profileDirty = true; stepError = null;
      syncPartner(); hello.setBubble(profileBubble());
    },
  }));
  const partnerBox = el('div', { class: 'trait-chips', role: 'group', 'aria-label': '내 짝은 이런 친구면 좋겠어요' }, partnerChips);
  // 고른 상태·카운터·(3개를 다 골랐을 때) 나머지 잠금을 제자리에서 맞춥니다
  const syncPartner = () => {
    const full = pd.partnerTraits.size >= PARTNER_MAX;
    counter.textContent = `${pd.partnerTraits.size} / ${PARTNER_MAX}`;
    counter.className = `pick-counter ${full ? 'full' : ''}`;
    partnerChips.forEach((chip, i) => {
      const on = pd.partnerTraits.has(traits[i].id);
      chip.classList.toggle('selected', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.disabled = locked || (!on && full);
    });
  };
  syncPartner();
  app.append(el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '③ 내 짝은 이런 친구면 좋겠어요' }), counter]),
    el('p', { class: 'muted', text: `${PARTNER_MAX}개만 골라요. ${PARTNER_MAX}개를 다 고르면 나머지는 잠깐 잠겨.` }),
    partnerBox,
  ]));

  // ④ 어떤 짝이 좋은지 글로
  const ta = el('textarea', { id: 'partner-text', maxlength: PARTNER_TEXT_MAX, placeholder: '예: 조용히 집중하는 짝이면 나도 수업에 더 집중할 수 있을 것 같아요.', disabled: locked ? true : null, style: { minHeight: '110px' } });
  ta.value = pd.partnerText;
  const cnt = el('div', { class: 'ta-counter', text: `${pd.partnerText.length} / ${PARTNER_TEXT_MAX}자` });
  const errBox = el('div', { class: 'alert error hidden', style: { margin: '8px 0 0' } });
  ta.addEventListener('input', () => {
    pd.partnerText = ta.value; profileDirty = true;
    cnt.textContent = `${ta.value.length} / ${PARTNER_TEXT_MAX}자`;
    if (stepError) { stepError = null; hello.setBubble(profileBubble()); errBox.classList.add('hidden'); }
  });
  app.append(el('section', { class: 'card' }, [
    el('h2', { text: '④ 저는 이런 짝과 앉으면 더 잘 지내고 공부도 잘할 것 같아요' }),
    el('p', { class: 'muted', text: '(단, 잘생긴/인기있는/특정인 X)' }),
    el('div', { class: 'field', style: { marginBottom: '0' } }, [
      ta,
      el('div', { class: 'help', text: '친구 이름은 적지 말고, 어떤 성격의 짝이면 좋을지 적어 줘. 이름을 적으면 저장되지 않아!' }),
      cnt,
    ]),
    errBox,
  ]));

  async function save() {
    if (pd.traits.size === 0) {
      hello.showError('나는 어떤 편인지 하나 이상 골라 줘!');
      toast('나는 어떤 편인지 하나 이상 골라 줘!');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    try {
      data = await api(`/api/student/${encodeURIComponent(token)}/profile`, {
        method: 'PUT',
        body: { traits: [...pd.traits], partnerTraits: [...pd.partnerTraits], partnerText: pd.partnerText.trim(), body: pd.body, roundId: data.round?.id },
      });
      initDrafts('profile');
      toast('저장했어! 🎉');
      goTo(neighborStep(1) || step);
    } catch (err) {
      hello.showError(err.message);
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
      toast(err.message, 5000);
      if (err.status === 403 || err.status === 409) await reloadAfterRoundChange(err.status);
    }
  }
  app.append(stepNav(save, '저장하고 다음으로 ▶'));
}

// ---------- ② 1인 1역 지원서 ----------
function appBubble() {
  if (data.room.locked) return '조사가 끝났어요!';
  const first = appDraft[0];
  if (appDraft.some((c) => c.stale)) return '선생님이 역할 목록을 바꿨어. 비어 있는 지망을 다시 골라 줘!';
  if (!appDraft.some((c) => c.roleId)) return '하고 싶은 역할을 골라 봐!';
  if (!first.roleId) return '1지망은 꼭 골라야 해!';
  if (first.reason.trim().length < REASON_MIN) return '1지망 이유를 정성껏 써 줘!';
  if (data.application && !appDirty) return '지원서 제출 완료! 멋져요';
  return '다 됐으면 지원서를 내 줘!';
}

function validateApplicationDraft() {
  const errors = {};
  const excluded = new Set(data.excludedRoleIds || []);
  const seen = new Set();
  appDraft.forEach((c, i) => {
    const e = {};
    if (!c.roleId) {
      if (i === 0) e.role = '1지망 역할을 골라 줘!';
    } else {
      const role = data.roles.find((r) => r.id === c.roleId);
      if (!role) e.role = '없는 역할이야. 다시 골라 줘.';
      else if (excluded.has(c.roleId)) e.role = `${role.name}${josa(role.name, ['은', '는'])} 지난달에 했던 역할이라 이번 달에는 지원할 수 없어.`;
      else if (seen.has(c.roleId)) e.role = `${role.name}${josa(role.name, ['은', '는'])} 이미 골랐어. 지망마다 다른 역할을 골라 줘.`;
      seen.add(c.roleId);
      const n = (c.reason || '').trim().length;
      if (n < REASON_MIN) e.reason = `${i + 1}지망: 하고 싶은 이유를 ${REASON_MIN}자 이상 적어 줘. (지금 ${n}자)`;
    }
    if (Object.keys(e).length) errors[i] = e;
  });
  return errors;
}

function renderApplication() {
  const locked = data.room.locked;
  const roles = data.roles || [];
  const excluded = new Set(data.excludedRoleIds || []);
  const hello = helloCard('이번 달에 하고 싶은 1인 1역을 골라서 지원서를 써 줘. 1지망은 꼭, 2·3지망은 골라도 돼.', appBubble());
  app.append(hello.card);
  let appNotice = null;
  if (data.application && applicationStale()) appNotice = el('div', { class: 'alert warn', style: { margin: '10px 0 0' }, text: locked ? '내가 냈던 지원서의 역할 중에 이제는 고를 수 없는 역할이 있어.' : '내가 냈던 지원서의 역할 중에 이제는 고를 수 없는 역할이 있어. 비어 있는 지망을 다시 골라서 지원서를 다시 내 줘!' });
  else if (data.application && !locked) appNotice = el('div', { class: 'alert success', style: { margin: '10px 0 0' }, text: '지원서 제출 완료! 끝나기 전까지는 언제든 바꾸고 다시 낼 수 있어.' });
  app.append(noticeCard(appNotice));

  // 선생님은 이렇게 뽑아요 + 규칙
  const criteria = data.selectionCriteria || [];
  const excludedNames = roles.filter((r) => excluded.has(r.id)).map((r) => r.name);
  app.append(el('section', { class: 'card' }, [
    el('h2', { text: '🧑‍🏫 선생님은 이렇게 뽑아요' }),
    el('ol', { class: 'criteria' }, criteria.map((c, i) => el('li', {}, [
      el('span', { class: 'k', text: String(i + 1) }),
      el('span', { text: criteria.length === KID_CRITERIA.length ? KID_CRITERIA[i] : c }),
    ]))),
    el('div', { class: 'alert warn rule', style: { margin: '12px 0 0' } }, [
      el('b', { text: '📌 규칙: 지난달에 맡은 역할은 이번 달에 지원할 수 없어.' }),
      el('div', { style: { marginTop: '4px' } }, excludedNames.length
        ? [`${data.previousRoleMonth ? `${data.previousRoleMonth}에` : '지난달에'} 내가 맡았던 역할: `, el('b', { id: 'excluded-roles', text: excludedNames.join(', ') }), ' → 이번 달엔 다른 역할을 골라 줘!']
        : ['지난달에 맡은 역할 기록이 없어서, 이번 달에는 모든 역할에 지원할 수 있어.']),
    ]),
  ]));

  // 역할 고르기
  const pickerBox = el('div', { class: 'role-grid' });
  const slotsBox = el('div', { id: 'wish-slots' });
  const chosenIndex = (roleId) => appDraft.findIndex((c) => c.roleId === roleId);
  // 카드·지망 칸을 다시 그리되, 누르고 있던 요소로 포커스를 되돌려 줍니다
  const refresh = () => {
    redrawKeepingFocus(pickerBox, drawPicker);
    redrawKeepingFocus(slotsBox, drawSlots);
    hello.setBubble(stepError || appBubble(), stepError ? 'oops' : '');
  };

  function pickRole(roleId) {
    if (locked) return;
    if (excluded.has(roleId)) { toast('지난달에 했던 역할이라 이번 달엔 지원할 수 없어.'); return; }
    const at = chosenIndex(roleId);
    if (at >= 0) { // 다시 누르면 그 지망에서 뺌 (쓴 글은 남겨 둠)
      appDraft[at].roleId = ''; appDirty = true; delete appErrors[at]; stepError = null; refresh(); return;
    }
    const empty = appDraft.findIndex((c) => !c.roleId);
    if (empty < 0) { toast('지망은 3개까지만 고를 수 있어. 먼저 하나를 빼 줘.'); return; }
    appDraft[empty].roleId = roleId; appDraft[empty].stale = null; appDirty = true;
    if (appErrors[empty]) delete appErrors[empty].role;
    stepError = null;
    refresh();
    toast(`${empty + 1}지망: ${roles.find((r) => r.id === roleId)?.name || ''}`);
  }

  function drawPicker() {
    pickerBox.replaceChildren(...roles.map((r) => {
      const ex = excluded.has(r.id);
      const at = chosenIndex(r.id);
      // 고르는 부분은 진짜 <button>, 설명(<details>)은 버튼 밖 형제 요소로
      return el('div', { class: `role-card ${ex ? 'excluded' : ''} ${at >= 0 ? `chosen rank-${at + 1}` : ''}` }, [
        ex ? el('span', { class: 'ribbon', 'aria-hidden': 'true', text: '지난달에 했던 역할' }) : null,
        el('button', {
          type: 'button',
          class: 'role-pick',
          disabled: ex || locked ? true : null,
          'aria-pressed': at >= 0 ? 'true' : 'false',
          'aria-label': ex ? `${r.name} (지난달에 했던 역할이라 고를 수 없어)` : null,
          dataset: { roleId: r.id },
          onClick: () => pickRole(r.id),
        }, [
          el('span', { class: 'role-head' }, [
            el('span', { class: 'role-name', text: r.name }),
            at >= 0 ? el('span', { class: 'pick-tag', text: `${at + 1}지망` }) : null,
            el('span', { class: 'badge gray slots', text: `${r.slots}명` }),
          ]),
          r.subtitle ? el('span', { class: 'role-sub', text: r.subtitle }) : null,
        ]),
        r.description ? el('details', {}, [
          el('summary', { text: '어떤 일을 해?' }),
          el('p', { text: r.description }),
        ]) : null,
      ]);
    }));
  }

  function textField(c, i, key, { label, required = false, placeholder, hint }) {
    const error = appErrors[i]?.[key];
    const ta = el('textarea', { maxlength: TEXT_MAX, placeholder, disabled: locked ? true : null, style: { minHeight: required ? '110px' : '80px' }, dataset: { field: key, slot: String(i) } });
    ta.value = c[key] || '';
    const counter = el('div', { class: 'ta-counter' });
    const errEl = el('div', { class: `field-error ${error ? '' : 'hidden'}`, text: error || '' });
    const update = () => {
      const n = ta.value.trim().length;
      if (required) {
        counter.textContent = n < REASON_MIN ? `${n}자 · 최소 ${REASON_MIN}자 (${REASON_MIN - n}자 더!)` : `${n}자 ✓`;
        counter.className = `ta-counter ${n < REASON_MIN ? 'bad' : 'ok'}`;
      } else {
        counter.textContent = `${ta.value.length} / ${TEXT_MAX}자`;
      }
    };
    ta.addEventListener('input', () => {
      c[key] = ta.value; appDirty = true; update();
      if (required && appErrors[i]?.reason && ta.value.trim().length >= REASON_MIN) { delete appErrors[i].reason; errEl.classList.add('hidden'); }
      if (stepError) stepError = null;
      hello.setBubble(appBubble());
    });
    update();
    return el('div', { class: 'field' }, [
      el('label', {}, [label, ' ', required ? el('span', { class: 'req', text: '(꼭 써 줘)' }) : el('span', { class: 'muted', text: '(선택)' })]),
      ta,
      hint ? el('div', { class: 'hint-bubble', text: `💡 ${hint}` }) : null,
      counter,
      errEl,
    ]);
  }

  function wishSlot(c, i) {
    const errs = appErrors[i] || {};
    const role = roles.find((r) => r.id === c.roleId);
    const options = [el('option', { value: '', text: i === 0 ? '— 1지망 역할을 골라 줘 —' : `— ${i + 1}지망 역할 (골라도 돼) —` })];
    for (const r of roles) {
      const ex = excluded.has(r.id);
      if (ex && c.roleId !== r.id) continue; // 지난달 역할은 목록에서 빼되, 이미 들어 있으면 보여 주고 고칠 수 있게
      const at = chosenIndex(r.id);
      const elsewhere = at >= 0 && at !== i;
      options.push(el('option', { value: r.id, disabled: elsewhere || ex ? true : null, text: ex ? `${r.name} (지난달에 했던 역할)` : elsewhere ? `${r.name} (${at + 1}지망에 골랐어)` : r.name }));
    }
    const sel = el('select', { disabled: locked ? true : null, 'aria-label': `${i + 1}지망 역할`, dataset: { slot: String(i) } }, options);
    sel.value = c.roleId || '';
    sel.addEventListener('change', () => {
      c.roleId = sel.value; appDirty = true;
      if (c.roleId) c.stale = null;
      if (appErrors[i]) delete appErrors[i].role;
      stepError = null; refresh();
    });
    const showText = Boolean(c.roleId) || Boolean(c.reason || c.helpClass || c.helpSelf);
    return el('section', { class: `card wish-slot rank-${i + 1} ${i === 0 ? 'first' : ''} ${c.roleId ? 'filled' : ''} ${errs.role || errs.reason ? 'has-error' : ''} ${c.stale ? 'stale' : ''}`, id: `wish-${i}` }, [
      el('div', { class: 'wish-head' }, [
        el('span', { class: 'wish-num', text: `${i + 1}지망` }),
        el('span', { class: 'muted', text: i === 0 ? '꼭 골라야 해' : '골라도 되고 안 골라도 돼' }),
        el('span', { class: 'spacer' }),
        c.roleId && !locked ? el('button', { type: 'button', class: 'btn small', text: '빼기', 'aria-label': `${i + 1}지망 빼기`, dataset: { action: 'remove', slot: String(i) }, onClick: () => { c.roleId = ''; appDirty = true; delete appErrors[i]; stepError = null; refresh(); } }) : null,
      ]),
      c.stale ? el('div', { class: 'slot-notice', role: 'status', text: `⚠️ ${staleText(c.stale)}` }) : null,
      el('div', { class: 'field', style: { marginBottom: '8px' } }, [sel, errs.role ? el('div', { class: 'field-error', text: errs.role }) : null]),
      role ? el('div', { class: 'wish-role' }, [
        el('b', { text: role.name }),
        role.subtitle ? el('span', { class: 'muted', text: ` · ${role.subtitle}` }) : null,
        role.description ? el('div', { class: 'wish-desc', text: role.description }) : null,
      ]) : null,
      ...(showText ? [
        textField(c, i, 'reason', { label: '이 역할을 하고 싶은 이유', required: true, placeholder: '예: 교실이 깨끗하면 기분이 좋아져서 매일 정리하고 싶어요. 지난달에도 청소를 빠뜨리지 않고 열심히 했어요.', hint: '3줄 이상 정성껏 쓰면 뽑힐 확률이 올라가!' }),
        textField(c, i, 'helpClass', { label: '이 역할이 우리 반에 어떤 도움이 될까?', placeholder: '예: 교실이 깨끗해져서 친구들이 기분 좋게 공부할 수 있어요.' }),
        textField(c, i, 'helpSelf', { label: '이 역할이 나에게 어떤 도움이 될까?', placeholder: '예: 정리하는 습관이 생기고 책임감이 커질 것 같아요.' }),
      ] : [el('p', { class: 'muted', style: { margin: '6px 0 0' }, text: '위에서 역할 카드를 누르거나, 여기서 역할을 골라 줘.' })]),
    ]);
  }

  function drawSlots() { slotsBox.replaceChildren(...appDraft.map((c, i) => wishSlot(c, i))); }

  drawPicker();
  drawSlots();
  app.append(el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '🧹 어떤 역할이 있을까?' }), el('span', { class: 'muted', text: `${roles.length}개 역할` })]),
    el('p', { class: 'muted' }, ['카드를 누르면 ', el('span', { class: 'rank-dot rank-1', text: '1지망' }), ' → ', el('span', { class: 'rank-dot rank-2', text: '2지망' }), ' → ', el('span', { class: 'rank-dot rank-3', text: '3지망' }), ' 순서로 들어가. 다시 누르면 빠져. "어떤 일을 해?"를 눌러 역할 설명을 꼭 읽어 봐!']),
    pickerBox,
  ]));
  app.append(el('h2', { class: 'wish-title', text: '✍️ 내 지원서' }));
  app.append(slotsBox);

  async function save() {
    appErrors = validateApplicationDraft();
    const firstIdx = Object.keys(appErrors).map(Number).sort((a, b) => a - b)[0];
    if (firstIdx !== undefined) {
      const e = appErrors[firstIdx];
      const msg = e.role || e.reason;
      hello.showError(msg);
      refresh();
      toast(msg, 4000);
      document.getElementById(`wish-${firstIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const choices = appDraft.filter((c) => c.roleId).map((c) => ({ roleId: c.roleId, reason: c.reason.trim(), helpClass: c.helpClass.trim(), helpSelf: c.helpSelf.trim() }));
    try {
      data = await api(`/api/student/${encodeURIComponent(token)}/application`, { method: 'PUT', body: { choices, roundId: data.round?.id } });
      initDrafts('application');
      toast('지원서를 냈어! 🎉');
      goTo(neighborStep(1) || step);
    } catch (err) {
      hello.showError(err.message);
      toast(err.message, 5000);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (err.status === 403 || err.status === 409) await reloadAfterRoundChange(err.status);
    }
  }
  app.append(stepNav(save, '지원서 내고 다음으로 ▶'));
}

// ---------- ③ 친구 관계 지도 ----------
function renderRelations() {
  const { me, room, classmates } = data;

  const m0 = mins();
  const g0 = Math.min(countOf('good'), m0.good);
  const b0 = Math.min(countOf('bad'), m0.bad);
  const need0 = m0.good + m0.bad;
  const pct0 = need0 ? (g0 + b0) / need0 : 1;
  const leftGood = Math.max(0, m0.good - countOf('good'));
  const leftBad = Math.max(0, m0.bad - countOf('bad'));
  const leftText = [leftGood ? `❤️ ${leftGood}명` : '', leftBad ? `⚡ ${leftBad}명` : ''].filter(Boolean).join(', ');
  const bubble = room.locked ? '조사가 끝났어요!' : selectedCount() === 0 ? '친구를 골라 볼까요?' : !minsMet() ? `${leftText} 더 골라 줘!` : data.submittedAt && !dirty ? '제출 완료! 멋져요' : '다 됐어요! 제출해요';
  const ring = el('div', { class: 'ring' }, [
    svgEl('svg', { viewBox: '0 0 112 112' }),
    el('div', { class: 'ring-text' }, [el('b', { text: `${g0 + b0}` }), el('span', { text: `/ ${need0}명` })]),
  ]);
  const rsvg = ring.querySelector('svg');
  rsvg.append(svgEl('circle', { cx: 56, cy: 56, r: 48, fill: 'none', stroke: '#f1ebe3', 'stroke-width': 12 }));
  rsvg.append(svgEl('circle', { cx: 56, cy: 56, r: 48, fill: 'none', stroke: pct0 >= 1 ? '#8bc34a' : '#ffd54f', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${(2 * Math.PI * 48 * pct0).toFixed(1)} ${(2 * Math.PI * 48).toFixed(1)}` }));
  const intro = el('section', { class: 'card hello-card' }, [
    ring,
    el('div', {}, [
      el('div', { class: 'badge blue', style: { marginBottom: '6px' }, text: `${data.round?.name || ''} 조사` }),
      el('h1', { text: `${me.name}, 안녕! 👋` }),
      el('p', { style: { marginBottom: '4px' } }, ['친구들과 나의 관계를 표시해 줘. ', el('b', { text: `❤️ 좋은 사이 ${m0.good}명` }), '과 ', el('b', { text: `⚡ 안 좋은 사이 ${m0.bad}명` }), ' 이상 꼭 골라야 해!']),
      el('div', { class: `speech ${pct0 >= 1 ? 'done' : ''}`, text: bubble }),
    ]),
  ]);
  app.append(intro);
  app.append(el('section', { class: 'card', style: { padding: '14px 18px' } }, [
    el('div', { class: 'alert info', style: { margin: 0 } }, ['🔒 이 페이지는 나만 볼 수 있어. 친구들은 내가 표시한 걸 볼 수 없고, 선생님만 확인해. 솔직하게 표시해 줘!']),
    room.locked ? el('div', { class: 'alert warn', style: { margin: '10px 0 0' }, text: lockedText() }) : null,
    data.submittedAt && !room.locked ? el('div', { class: 'alert success', style: { margin: '10px 0 0' }, text: '제출 완료! 끝나기 전까지는 언제든 바꾸고 다시 제출할 수 있어.' }) : null,
  ]));

  // 진행 상황
  const m = mins();
  const gc = countOf('good');
  const bc = countOf('bad');
  const done = minsMet();
  const progress = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h2', { text: '🗺️ 내 관계 지도' }),
      el('div', { class: 'btn-row', style: { gap: '6px' } }, [
        el('span', { class: `badge ${gc >= m.good ? 'green' : 'warn'}`, text: `❤️ ${gc} / ${m.good}명` }),
        el('span', { class: `badge ${bc >= m.bad ? 'green' : 'warn'}`, text: `⚡ ${bc} / ${m.bad}명` }),
      ]),
    ]),
    el('div', { class: 'progress' }, [el('div', { class: done ? 'done' : '', style: { width: `${Math.round(pct0 * 100)}%` } })]),
    el('div', { class: 'student-map', id: 'map', style: { marginTop: '10px' } }),
    el('div', { class: 'legend', style: { marginTop: '6px' } }, [
      el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--kid-coral)', borderRadius: '50%', width: '16px', height: '16px', border: '2px solid #fff' } }), '나']),
      el('span', {}, [el('span', { class: 'sw', style: { background: '#fff', border: '2px solid #e8dfd3', borderRadius: '8px' } }), '친구']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--kid-coral)' } }), '❤️ 좋은 사이']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--kid-slate)' } }), '⚡ 안 좋은 사이']),
    ]),
    el('p', { class: 'muted', style: { marginTop: '8px' }, text: '지도에서 친구 이름을 누르거나, 아래 목록에서 친구를 골라 봐.' }),
  ]);
  app.append(progress);
  drawMap(progress.querySelector('#map'));

  // 친구 목록
  const list = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '🧒 우리 반 친구들' }), el('span', { class: 'muted', text: `${classmates.length}명` })]),
    el('div', { class: 'mate-list' }, classmates.map((c, i) => mateButton(c, i))),
    !room.locked ? stickyBar() : null,
  ]);
  app.append(list);
  app.append(stepNav(null));
}

function mateButton(c, i = 0) {
  const r = draft[c.id];
  const type = r?.type;
  const invalid = r && !relationValid(r);
  const sub = r
    ? invalid
      ? '⚠️ 이유를 꼭 적어 줘'
      : [...(r.tags || []).map((t) => tagLabel(type, t)), r.reason].filter(Boolean).join(', ') || '이유 없음'
    : '눌러서 표시하기';
  return el('button', {
    type: 'button',
    class: `mate ${type || ''}`,
    onClick: () => openEditor(c.id),
    disabled: data.room.locked ? true : null,
  }, [
    el('span', { class: 'avatar', style: { background: avatarColor(i) }, text: (c.name.length === 3 ? c.name.slice(1, 2) : c.name.slice(0, 1)) }),
    el('span', { class: 'name' }, [c.name, el('span', { class: 'sub', text: sub })]),
    type ? el('span', { class: `badge ${type}`, text: `${TYPE_ICON[type]} ${TYPE_LABEL[type]}` }) : el('span', { class: 'badge gray', text: '선택 안 함' }),
  ]);
}

function tagLabel(type, id) {
  return data.catalog[type]?.find((t) => t.id === id)?.label || id;
}

function stickyBar() {
  const m = mins();
  const leftGood = Math.max(0, m.good - countOf('good'));
  const leftBad = Math.max(0, m.bad - countOf('bad'));
  const invalid = invalidNames();
  let status;
  if (invalid.length) status = `⚠️ ${invalid.join(', ')}${josa(invalid[invalid.length - 1], ['와', '과'])} 안 좋은 사이인 이유를 적어 줘.`;
  else if (leftGood || leftBad) status = `${[leftGood ? `❤️ 좋은 사이 ${leftGood}명` : '', leftBad ? `⚡ 안 좋은 사이 ${leftBad}명` : ''].filter(Boolean).join(', ')} 더 골라 줘!`;
  else if (dirty) status = '🌟 다 됐어! 제출 버튼을 눌러 줘.';
  else if (data.submittedAt) status = '제출 완료! 바꾼 게 있으면 다시 제출해 줘.';
  else status = '🌟 다 됐어! 제출 버튼을 눌러 줘.';
  return el('div', { class: 'sticky-bar' }, [
    el('div', { class: 'status', text: status }),
    el('button', { type: 'button', class: 'btn primary', text: data.submittedAt ? '다시 제출하기 ▶' : '제출하기 ▶', disabled: canSubmit() ? null : true, onClick: submit }),
  ]);
}

// ---------- 마인드맵 ----------
function drawMap(container) {
  const mates = data.classmates;
  const n = mates.length;
  const NODE_W = 104, NODE_H = 42, GAP = 16;
  const rings = [];
  let idx = 0, k = 1;
  while (idx < n) {
    const r = 150 + (k - 1) * 120;
    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / (NODE_W + GAP)));
    const count = Math.min(cap, n - idx);
    rings.push({ r, count, start: idx });
    idx += count;
    k++;
  }
  const pos = {};
  for (const ring of rings) {
    for (let j = 0; j < ring.count; j++) {
      const angle = (2 * Math.PI * j) / ring.count - Math.PI / 2;
      pos[mates[ring.start + j].id] = { x: ring.r * 1.15 * Math.cos(angle), y: ring.r * Math.sin(angle) };
    }
  }
  const maxR = rings.length ? rings[rings.length - 1].r : 150;
  const pad = 80;
  const vb = { x: -maxR * 1.15 - pad, y: -maxR - NODE_H, w: maxR * 2.3 + pad * 2, h: maxR * 2 + NODE_H * 2 };
  const svg = svgEl('svg', { viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, role: 'img', 'aria-label': '내 친구 관계 지도' });

  const defs = svgEl('defs');
  const sky = svgEl('linearGradient', { id: 'sky', x1: 0, y1: 0, x2: 0, y2: 1 });
  sky.append(svgEl('stop', { offset: '0', 'stop-color': '#8fcdf2' }), svgEl('stop', { offset: '1', 'stop-color': '#e6f5ff' }));
  defs.append(sky);
  const meGrad = svgEl('radialGradient', { id: 'me-grad', cx: '38%', cy: '32%', r: '72%' });
  meGrad.append(svgEl('stop', { offset: '0', 'stop-color': '#ff8585' }), svgEl('stop', { offset: '1', 'stop-color': '#ea5563' }));
  defs.append(meGrad);
  const sunGrad = svgEl('radialGradient', { id: 'sun-grad', cx: '50%', cy: '50%', r: '50%' });
  sunGrad.append(svgEl('stop', { offset: '0', 'stop-color': '#ffe08a' }), svgEl('stop', { offset: '0.55', 'stop-color': '#ffd454', 'stop-opacity': '.9' }), svgEl('stop', { offset: '1', 'stop-color': '#ffd454', 'stop-opacity': '0' }));
  defs.append(sunGrad);
  for (const [id, color] of [['arrow-good', '#ff6b6b'], ['arrow-bad', '#4a5568']]) {
    const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.append(m);
  }
  svg.append(defs);

  // 배경: 하늘, 해, 구름, 언덕
  const deco = svgEl('g', { 'pointer-events': 'none' });
  deco.append(svgEl('rect', { x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: 'url(#sky)' }));
  deco.append(svgEl('circle', { cx: vb.x + vb.w - 80, cy: vb.y + 70, r: 60, fill: 'url(#sun-grad)' }));
  const cloud = (cx, cy, k) => {
    const g = svgEl('g', { fill: '#fff', opacity: '.85' });
    g.append(svgEl('circle', { cx: cx - 24 * k, cy: cy + 2 * k, r: 14 * k }), svgEl('circle', { cx: cx - 6 * k, cy: cy - 10 * k, r: 20 * k }), svgEl('circle', { cx: cx + 16 * k, cy: cy - 4 * k, r: 16 * k }), svgEl('circle', { cx: cx + 30 * k, cy: cy + 4 * k, r: 11 * k }), svgEl('rect', { x: cx - 36 * k, y: cy - 2 * k, width: 76 * k, height: 16 * k, rx: 8 * k }));
    return g;
  };
  deco.append(cloud(vb.x + 90, vb.y + 70, 1), cloud(vb.x + vb.w * 0.55, vb.y + 40, 0.8), cloud(vb.x + vb.w - 160, vb.y + vb.h * 0.35, 0.7));
  deco.append(svgEl('ellipse', { cx: vb.x + vb.w * 0.3, cy: vb.y + vb.h + 40, rx: vb.w * 0.55, ry: 120, fill: '#9ad04a' }));
  deco.append(svgEl('ellipse', { cx: vb.x + vb.w * 0.8, cy: vb.y + vb.h + 60, rx: vb.w * 0.5, ry: 130, fill: '#7cb342' }));
  svg.append(deco);

  const me = { x: 0, y: 0 };
  const ME_R = 36; // '나' 동그라미 반지름
  const edges = svgEl('g');
  for (const c of mates) {
    const r = draft[c.id];
    if (!r) continue;
    const p = pos[c.id];
    const start = circleEdge(me, ME_R + 4, p);
    const end = rectEdge(p, NODE_W, NODE_H, me);
    edges.append(svgEl('path', {
      d: `M${start.x},${start.y} L${end.x},${end.y}`,
      stroke: r.type === 'good' ? '#ff6b6b' : '#4a5568', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round',
      'marker-end': `url(#${r.type === 'good' ? 'arrow-good' : 'arrow-bad'})`,
    }));
  }
  svg.append(edges);

  const nodes = svgEl('g');
  for (const c of mates) {
    const p = pos[c.id];
    const r = draft[c.id];
    const g = svgEl('g', { class: `node ${r ? r.type : ''}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': c.name });
    const rect = svgEl('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: NODE_H / 2 });
    g.append(rect, svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: shorten(c.name, 6), style: 'font-size:18px' }));
    if (r) {
      const badge = svgEl('g', { class: 'node-badge', transform: `translate(${NODE_W / 2 - 6},${-NODE_H / 2 + 2})` });
      badge.append(svgEl('circle', { r: 13, fill: '#fff', stroke: r.type === 'good' ? '#ff6b6b' : '#4a5568', 'stroke-width': 2.5 }));
      badge.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: r.type === 'good' ? '❤️' : '⚡', style: 'font-size:14px' }));
      g.append(badge);
    }
    if (!data.room.locked) {
      g.addEventListener('click', () => openEditor(c.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(c.id); } });
    }
    nodes.append(g);
  }
  // '나'는 빨간 동그라미로 강조
  const meNode = svgEl('g', { class: 'node me', transform: 'translate(0,0)' });
  meNode.append(svgEl('circle', { class: 'me-halo', r: ME_R + 10 }));
  meNode.append(svgEl('ellipse', { cx: 0, cy: ME_R + 4, rx: ME_R * 0.7, ry: 4, fill: '#4a3b2f', opacity: '.10' }));
  meNode.append(svgEl('circle', { class: 'me-body', r: ME_R, fill: 'url(#me-grad)' }));
  meNode.append(svgEl('ellipse', { cx: -ME_R * 0.3, cy: -ME_R * 0.42, rx: ME_R * 0.32, ry: ME_R * 0.2, fill: '#fff', opacity: '.28', transform: `rotate(-20 ${-ME_R * 0.3} ${-ME_R * 0.42})` }));
  // 눈, 볼, 입
  for (const sx of [-10, 10]) {
    meNode.append(svgEl('ellipse', { cx: sx, cy: -2, rx: 4, ry: 5.4, fill: '#2d2f3a' }));
    meNode.append(svgEl('circle', { cx: sx + 1.5, cy: -4, r: 1.4, fill: '#fff' }));
  }
  meNode.append(svgEl('circle', { cx: -20, cy: 8, r: 5, fill: '#ffd2d2', opacity: '.6' }), svgEl('circle', { cx: 20, cy: 8, r: 5, fill: '#ffd2d2', opacity: '.6' }));
  meNode.append(svgEl('path', { d: 'M-7 11 Q0 17 7 11', fill: 'none', stroke: '#2d2f3a', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  const meLabel = svgEl('g', { transform: `translate(0,${ME_R + 16})` });
  meLabel.append(svgEl('rect', { x: -22, y: -12, width: 44, height: 24, rx: 12, fill: '#fff', stroke: '#ff6b6b', 'stroke-width': 2 }));
  meLabel.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: '나', style: 'font-size:16px;fill:#4a3b2f' }));
  meNode.append(meLabel);
  nodes.append(meNode);
  svg.append(nodes);
  container.replaceChildren(svg);
}

function shorten(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

// 원(중심 c, 반지름 r)에서 목표점 t 방향으로 나가는 경계점
function circleEdge(c, r, t) {
  const dx = t.x - c.x, dy = t.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
}

// 사각형(중심 c, 폭 w, 높이 h)에서 목표점 t 방향으로 나가는 경계점
function rectEdge(c, w, h, t) {
  const dx = t.x - c.x, dy = t.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const padScale = 1 + 4 / Math.hypot(dx * s, dy * s);
  return { x: c.x + dx * s * padScale, y: c.y + dy * s * padScale };
}

// ---------- 편집 모달 ----------
function openEditor(id) {
  if (data.room.locked) return;
  const mate = data.classmates.find((c) => c.id === id);
  const current = draft[id] ? JSON.parse(JSON.stringify(draft[id])) : null;
  const state = { type: current?.type || null, tags: new Set(current?.tags || []), reason: current?.reason || '' };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }

  function draw() {
    modal.replaceChildren();
    modal.append(el('h2', { text: `${mate.name}${josa(mate.name, ['와', '과'])} 나는…` }));
    const choice = el('div', { class: 'type-choice' }, [
      el('button', { type: 'button', class: `type-btn good ${state.type === 'good' ? 'selected' : ''}`, onClick: () => { state.type = state.type === 'good' ? null : 'good'; state.tags.clear(); draw(); } }, [
        el('span', { class: 'big', text: '❤️' }), '좋은 사이', el('span', { class: 'desc', text: '빨간 화살표 · 이유는 골라도 되고 안 골라도 돼' }),
      ]),
      el('button', { type: 'button', class: `type-btn bad ${state.type === 'bad' ? 'selected' : ''}`, onClick: () => { state.type = state.type === 'bad' ? null : 'bad'; state.tags.clear(); draw(); } }, [
        el('span', { class: 'big', text: '⚡' }), '안 좋은 사이', el('span', { class: 'desc', text: '검은 화살표 · 이유를 꼭 적어야 해' }),
      ]),
    ]);
    modal.append(choice);

    if (state.type) {
      const isBad = state.type === 'bad';
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, [isBad ? '어떤 점이 안 좋아? ' : '왜 좋은 사이야? ', el('span', { class: 'muted', text: '(골라도 되고 안 골라도 돼)' })]),
        el('div', { class: 'chips' }, data.catalog[state.type].map((t) => el('button', {
          type: 'button',
          class: `chip ${state.tags.has(t.id) ? `selected ${isBad ? 'bad-theme' : 'good-theme'}` : ''}`,
          text: `${t.emoji ? `${t.emoji} ` : ''}${t.label}`,
          onClick: () => { state.tags.has(t.id) ? state.tags.delete(t.id) : state.tags.add(t.id); draw(); },
        }))),
      ]));
      const ta = el('textarea', { placeholder: isBad ? '예: 지난주에 내 물건을 허락 없이 가져갔어요. 무슨 일이 있었는지 적어 줘.' : '예: 쉬는 시간에 항상 같이 놀아요.', maxlength: 300, style: isBad ? { minHeight: '110px', borderColor: 'var(--kid-coral)' } : { minHeight: '90px' } });
      ta.value = state.reason;
      ta.addEventListener('input', () => { state.reason = ta.value; updateHint(); });
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, ['✏️ 이유 적기 ', isBad ? el('span', { class: 'req', text: '(꼭 적어 줘)' }) : el('span', { class: 'muted', text: '(선택)' })]),
        ta,
      ]));
      const hint = el('div', { class: 'alert warn hidden', id: 'editor-hint', text: '안 좋은 사이일 때는 무슨 일이 있었는지 이유를 꼭 적어 줘. 선생님만 볼 수 있어.' });
      modal.append(hint);
      var updateHint = () => hint.classList.toggle('hidden', !(isBad && state.reason.trim().length < 2));
      updateHint();
    } else {
      modal.append(el('p', { class: 'muted', text: '위에서 관계를 골라 줘. 아직 잘 모르겠으면 표시하지 않아도 괜찮아.' }));
    }

    modal.append(el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn primary', text: '저장 ✓', onClick: save }),
      current ? el('button', { type: 'button', class: 'btn', text: '표시 지우기', onClick: () => { delete draft[id]; dirty = true; close(); render(); } }) : null,
      el('button', { type: 'button', class: 'btn', text: '닫기', onClick: close }),
    ]));
  }

  function save() {
    if (!state.type) { delete draft[id]; dirty = true; close(); render(); return; }
    const r = { type: state.type, tags: [...state.tags], reason: state.reason.trim() };
    if (!relationValid(r)) { toast('안 좋은 사이일 때는 이유를 꼭 적어 줘! (2자 이상)'); return; }
    draft[id] = r;
    dirty = true;
    close();
    render();
  }

  draw();
  document.body.append(backdrop);
}

// ---------- 제출 ----------
async function submit() {
  if (!canSubmit()) return;
  try {
    data = await api(`/api/student/${encodeURIComponent(token)}/relations`, { method: 'PUT', body: { relations: draft, roundId: data.round?.id } });
    draft = JSON.parse(JSON.stringify(data.relations));
    dirty = false;
    render();
    toast('제출 완료! 정말 고마워 🎉');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 5000);
    if (err.status === 403 || err.status === 409) await reloadAfterRoundChange(err.status);
  }
}

window.addEventListener('beforeunload', (e) => {
  if (dirty || profileDirty || appDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 시작 ----------
(async () => {
  try {
    data = await api(`/api/student/${encodeURIComponent(token)}`);
    draft = JSON.parse(JSON.stringify(data.relations || {}));
    initDrafts();
    step = firstIncompleteStep();
    render();
  } catch (err) {
    app.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: '페이지를 열 수 없어요' }),
      el('p', { text: err.message }),
    ]));
  }
})();
