import { api, el, setChildren, toast, fmtDate, setupPageNav } from './common.js';

const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(token)}/groups`;
const app = document.getElementById('app');
const initialRound = new URLSearchParams(location.search).get('round');
let data, draft, editing = null, preview = null, dirty = false, busy = false, seed = 1;
let notice = '', noticeKind = 'info', move = { studentId: '', targetId: '', swapId: '' };
let createMutationId = null, createUncertain = false;
const newMutationId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const clone = (value) => structuredClone(value);
const pairKey = (a, b) => [a, b].sort().join('|');
const nameOf = (id) => data.students.find((student) => student.id === id)?.name || '(명단에서 삭제됨)';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const opts = () => ({ title: draft.title, activityDate: draft.activityDate, roundId: draft.roundId, groupSize: draft.groupSize, avoidRepeats: draft.avoidRepeats, absentIds: draft.absentIds, apartPairs: draft.apartPairs });
const button = (text, onClick, attrs = {}) => el('button', { type: 'button', class: 'btn', disabled: busy, text, onClick, ...attrs });
const field = (label, node, hint) => el('label', { class: 'groups-field' }, [el('span', { text: label }), node, hint ? el('small', { class: 'muted', text: hint }) : null]);
function input(type, value, attrs, change) {
  const node = el('input', { type, ...attrs }); node.value = value;
  node.addEventListener('input', () => change(node.value));
  return node;
}
function select(value, choices, attrs, change) {
  const node = el('select', attrs, choices.map(([id, name]) => el('option', { value: id, text: name })));
  node.value = value;
  node.addEventListener('change', () => change(node.value));
  return node;
}
function setNotice(message, kind = 'info') { notice = message; noticeKind = kind; renderNotice(); }
function markDirty(clearPreview = true) {
  dirty = true;
  if (clearPreview) { preview = null; renderPreview(); }
  const node = document.getElementById('groups-save-state');
  if (node) node.textContent = '저장하지 않은 편집안';
  renderPrint();
}
function effectiveApart() {
  return [...new Map([...data.teacherApartPairs, ...draft.apartPairs].map((pair) => [pairKey(pair.a, pair.b), pair])).values()];
}
function localIssue(groups = draft.groups) {
  const present = data.students.filter(({ id }) => !draft.absentIds.includes(id)).map(({ id }) => id);
  if (present.length < 2) return '참여 학생이 2명 이상이어야 해요.';
  if (!groups?.length) return '조건을 정한 뒤 후보를 만들고 편집안에 적용해 주세요.';
  const count = Math.ceil(present.length / draft.groupSize);
  if (groups.length !== count) return '참여 인원이나 최대 인원이 바뀌었어요. 새 후보를 만들어 적용해 주세요.';
  const assigned = groups.flatMap((group) => group.studentIds);
  if (assigned.length !== present.length || new Set(assigned).size !== present.length || assigned.some((id) => !present.includes(id))) return '명단과 편성안이 달라요. 빠지는 학생을 확인하고 새 후보를 적용해 주세요.';
  const sizes = groups.map((group) => group.studentIds.length);
  if (Math.max(...sizes) > draft.groupSize || Math.max(...sizes) - Math.min(...sizes) > 1) return '모둠 인원 차이는 1명 이내여야 해요. 큰 모둠에서 작은 모둠으로 옮기거나 맞바꿔 주세요.';
  for (const pair of effectiveApart()) if (groups.some((group) => group.studentIds.includes(pair.a) && group.studentIds.includes(pair.b))) return `${nameOf(pair.a)} · ${nameOf(pair.b)} 학생은 반드시 다른 모둠에 있어야 해요.`;
  return '';
}

async function load({ initial = false } = {}) {
  const round = initial ? initialRound : draft?.roundId;
  try {
    data = await api(`${base}${round ? `?round=${encodeURIComponent(round)}` : ''}`);
    if (initial) freshDraft();
    else setNotice('최신 학생 명단과 저장 목록을 읽었어요. 현재 편집안은 그대로예요.');
    setupPageNav(token, draft.roundId);
    document.title = `${data.room.name} 모둠·짝 편성`;
    render();
  } catch (err) {
    if (initial) setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '모둠 편성을 열 수 없어요' }), el('p', { text: err.message }), el('a', { class: 'btn', href: `/t/${encodeURIComponent(token)}/groups`, text: '현재 회차로 열기' })]));
    else setNotice(err.message, 'error');
  }
}
function freshDraft() {
  draft = { title: '', activityDate: today(), roundId: data.round.id, groupSize: 4, avoidRepeats: true, absentIds: [], apartPairs: [], groups: [] };
  editing = null; preview = null; dirty = false; move = { studentId: '', targetId: '', swapId: '' };
  createMutationId = null; createUncertain = false;
}
function canLeaveDraft() { return !dirty || confirm('저장하지 않은 편집안이 있어요. 이 편집안을 닫고 계속할까요?'); }
function openActivity(activity, duplicate = false) {
  if (busy || !canLeaveDraft()) return;
  draft = clone(activity);
  if (duplicate) { draft.title = `${activity.title} (복사)`.slice(0, 80); draft.activityDate = today(); }
  editing = duplicate ? null : { id: activity.id, version: activity.version };
  createMutationId = null; createUncertain = false;
  preview = null; dirty = duplicate; move = { studentId: '', targetId: '', swapId: '' };
  notice = duplicate ? '이전 구성을 새 활동으로 가져왔어요. 날짜와 조건을 확인한 뒤 저장하세요.' : '저장한 활동을 열었어요. 수정 후 저장해야 기록이 바뀝니다.';
  noticeKind = 'info'; setupPageNav(token, draft.roundId); render();
  document.getElementById('groups-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function generate() {
  if (busy) return;
  busy = true; notice = '분리 조건을 지키면서 모둠을 편성하고 있어요…'; noticeKind = 'info'; render();
  try {
    preview = await api(`${base}/preview`, { method: 'POST', body: { ...opts(), seed: seed++, excludeActivityId: editing?.id || null } });
    setNotice(preview.candidate ? '후보를 만들었어요. 이름을 확인하고 편집안에 적용해 주세요.' : preview.warnings.join(' '), preview.candidate ? 'info' : 'warn');
  } catch (err) { setNotice(`${err.message} 현재 편집안은 보존했어요.`, 'error'); }
  finally { busy = false; render(); }
}
function applyPreview() {
  if (!preview?.candidate || busy) return;
  if (draft.groups.length && !confirm('후보의 학생 구성을 현재 편집안에 적용할까요? 저장한 활동은 저장 버튼을 누르기 전까지 바뀌지 않아요.')) return;
  draft = clone(preview.candidate); preview = null; dirty = true;
  move = { studentId: '', targetId: '', swapId: '' };
  setNotice('후보를 편집안에 적용했어요. 필요하면 학생을 옮기고 저장해 주세요.'); render();
}
async function save(asNew = false) {
  if (busy) return;
  const issue = localIssue();
  if (issue) return setNotice(issue, 'warn');
  busy = true; render();
  const old = asNew ? null : editing;
  try {
    if (!old && !createMutationId) createMutationId = newMutationId();
    const result = await api(`${base}${old ? `/${encodeURIComponent(old.id)}` : ''}`, {
      method: old ? 'PUT' : 'POST', body: { ...opts(), groups: draft.groups, ...(old ? { expectedVersion: old.version } : { clientMutationId: createMutationId }) },
    });
    data.activities = result.activities; draft = clone(result.activity);
    editing = { id: result.activity.id, version: result.activity.version }; dirty = false; preview = null;
    createMutationId = null; createUncertain = false;
    setNotice('활동을 저장했어요. 학생용 인쇄에는 모둠 번호와 이름만 표시됩니다.');
  } catch (err) {
    if (!old) createUncertain = true;
    setNotice(err.status === 409 ? `${err.message} ‘최신 목록 읽기’ 후 저장한 기록을 다시 열거나, 내 편집안을 새 활동으로 저장할 수 있어요.` : `${err.message} 입력한 편집안은 그대로예요.`, 'error');
  } finally { busy = false; render(); }
}
async function recoverCreated() {
  if (busy || !createMutationId) return;
  busy = true; render();
  let existing = null;
  try {
    const fresh = await api(base);
    data = fresh;
    existing = fresh.activities.find((activity) => activity.clientMutationId === createMutationId);
    if (!existing) setNotice('앞선 요청으로 저장된 활동을 찾지 못했어요. 같은 내용으로 저장을 다시 누르면 중복 없이 재시도합니다.', 'warn');
  } catch (err) { setNotice(err.message, 'error'); }
  finally { busy = false; render(); }
  if (existing) openActivity(existing);
}
function saveSeparateActivity() {
  if (busy || !confirm('앞선 저장이 성공했다면 두 활동이 남을 수 있어요. 지금 편집안을 별도 새 활동으로 저장할까요?')) return;
  createMutationId = null; createUncertain = false;
  void save(true);
}
async function remove(activity) {
  if (busy || !confirm(`‘${activity.title}’ 활동 기록을 삭제할까요? 이 활동의 반복 조합 기록도 함께 사라져요.`)) return;
  busy = true; render();
  try {
    const result = await api(`${base}/${encodeURIComponent(activity.id)}`, { method: 'DELETE', body: { expectedVersion: activity.version } });
    data.activities = result.activities;
    if (editing?.id === activity.id) { editing = null; dirty = true; }
    setNotice('저장 기록을 삭제했어요. 화면의 편집안은 필요하면 새 활동으로 저장할 수 있어요.');
  } catch (err) { setNotice(err.message, 'error'); }
  finally { busy = false; render(); }
}

function moveStudent() {
  const source = draft.groups.find((group) => group.studentIds.includes(move.studentId));
  const target = draft.groups.find((group) => group.id === move.targetId);
  if (!source || !target || source.id === target.id) return toast('학생과 다른 모둠을 선택해 주세요.');
  const groups = clone(draft.groups);
  const from = groups.find((group) => group.id === source.id), to = groups.find((group) => group.id === target.id);
  const sourceIndex = from.studentIds.indexOf(move.studentId);
  if (move.swapId) {
    const targetIndex = to.studentIds.indexOf(move.swapId);
    if (targetIndex < 0) return toast('맞바꿀 학생을 다시 선택해 주세요.');
    [from.studentIds[sourceIndex], to.studentIds[targetIndex]] = [to.studentIds[targetIndex], from.studentIds[sourceIndex]];
  } else { from.studentIds.splice(sourceIndex, 1); to.studentIds.push(move.studentId); }
  const issue = localIssue(groups);
  if (issue) return setNotice(issue, 'warn');
  draft.groups = groups; dirty = true; preview = null; move = { studentId: '', targetId: '', swapId: '' };
  setNotice('학생 구성을 바꿨어요. 저장하면 활동 기록에 반영됩니다.'); render();
}

function renderNotice() {
  const node = document.getElementById('groups-notice');
  if (node) { node.className = `alert ${noticeKind}${notice ? '' : ' hidden'}`; node.textContent = notice; }
}
function renderSettings() {
  const knownTeacher = new Set(data.teacherApartPairs.map(({ a, b }) => pairKey(a, b)));
  const extraPairs = draft.apartPairs.filter(({ a, b }) => !knownTeacher.has(pairKey(a, b)));
  const pairSelect = (id, label) => select('', [['', label], ...data.students.map((student) => [student.id, student.name])], { id, 'aria-label': label }, () => {});
  const a = pairSelect('groups-apart-a', '첫 번째 학생'), b = pairSelect('groups-apart-b', '두 번째 학생');
  const checkRepeat = el('input', { type: 'checkbox', checked: draft.avoidRepeats, onChange: (e) => { draft.avoidRepeats = e.target.checked; markDirty(); } });
  return el('section', { class: 'card groups-settings' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '1. 활동 조건' }), el('span', { class: 'muted', text: '결석·분리 조건은 선생님에게만 보여요' })]),
    el('fieldset', { disabled: busy, class: 'groups-fields' }, [
      field('활동 이름', input('text', draft.title, { id: 'groups-title', maxlength: 80, placeholder: '예: 과학 실험 · 4인 모둠' }, (value) => { draft.title = value; markDirty(); })),
      field('활동 날짜', input('date', draft.activityDate, { id: 'groups-date' }, (value) => { draft.activityDate = value; markDirty(); })),
      field('기준 회차', select(draft.roundId, data.rounds.map((round) => [round.id, round.name]), { id: 'groups-round' }, (value) => { draft.roundId = value; markDirty(); setupPageNav(token, value); }), '활동을 어느 조사 회차와 함께 보관할지 선택해요.'),
      field('모둠 최대 인원', select(String(draft.groupSize), Array.from({ length: 7 }, (_, i) => [String(i + 2), i === 0 ? '2명 · 짝 활동' : `${i + 2}명`]), { id: 'groups-size' }, (value) => { draft.groupSize = Number(value); markDirty(); renderBoard(); }), '최대 인원 안에서 모둠별 차이가 1명 이내가 되도록 나눠요.'),
    ]),
    el('fieldset', { disabled: busy, class: 'groups-options' }, [
      el('details', {}, [el('summary', { text: `이번 활동에서 빠지는 학생 (${draft.absentIds.length}명)` }),
        el('p', { class: 'muted', text: '결석하거나 다른 활동을 하는 학생을 체크하세요. 명단에서 삭제되지는 않아요.' }),
        el('div', { class: 'groups-roster' }, data.students.map((student) => el('label', { class: 'groups-check' }, [
          el('input', { type: 'checkbox', checked: draft.absentIds.includes(student.id), onChange: (event) => {
            draft.absentIds = event.target.checked ? [...draft.absentIds, student.id] : draft.absentIds.filter((id) => id !== student.id); markDirty(); renderBoard();
            const summary = event.target.closest('details').querySelector('summary'); summary.textContent = `이번 활동에서 빠지는 학생 (${draft.absentIds.length}명)`;
          } }), student.name,
        ]))),
      ]),
      el('details', {}, [el('summary', { text: `반드시 다른 모둠에 둘 학생 (${effectiveApart().length}쌍)` }),
        el('p', { class: 'muted', text: '자리 배정의 ‘떨어뜨리기’ 규칙은 항상 반영해요. 학생 응답만으로 분리를 강제하지 않아요.' }),
        data.teacherApartPairs.length ? el('ul', { class: 'groups-pair-list' }, data.teacherApartPairs.map((pair) => el('li', {}, [`${nameOf(pair.a)} · ${nameOf(pair.b)}`, el('span', { class: 'badge gray', text: '기존 교사 규칙' })]))) : el('p', { class: 'muted', text: '기존 떨어뜨리기 규칙이 없어요.' }),
        el('div', { class: 'groups-pair-add' }, [a, b, button('이번 활동에 분리 추가', () => {
          if (!a.value || !b.value || a.value === b.value) return toast('서로 다른 학생 두 명을 선택해 주세요.');
          if (effectiveApart().some((pair) => pairKey(pair.a, pair.b) === pairKey(a.value, b.value))) return toast('이미 분리할 학생으로 지정되어 있어요.');
          draft.apartPairs.push({ a: a.value, b: b.value }); markDirty(); render();
        }, { id: 'groups-add-apart' })]),
        el('ul', { class: 'groups-pair-list' }, extraPairs.map((pair) => el('li', {}, [`${nameOf(pair.a)} · ${nameOf(pair.b)}`, button('분리 해제', () => { draft.apartPairs = draft.apartPairs.filter((item) => pairKey(item.a, item.b) !== pairKey(pair.a, pair.b)); markDirty(); render(); }, { class: 'btn small' })]))),
      ]),
      el('label', { class: 'groups-check groups-repeat' }, [checkRepeat, el('span', {}, [el('b', { text: '이전 활동에서 함께했던 조합 줄이기' }), el('small', { class: 'muted', text: '이 날짜까지 저장한 활동을 참고해요. 반복은 가능한 범위에서 줄이고, 반드시 분리할 조건을 먼저 지켜요.' })])]),
    ]),
    el('div', { class: 'btn-row' }, [button(busy ? '처리 중…' : '조건으로 후보 만들기', generate, { class: 'btn primary', id: 'groups-generate' }), el('span', { class: 'muted', text: '후보를 만드는 것만으로 저장한 활동이 바뀌지 않아요.' })]),
  ]);
}
function groupCards(groups, editable = false) {
  return el('div', { class: 'groups-grid' }, groups.map((group, index) => el('article', { class: 'groups-group' }, [
    el('div', { class: 'groups-group-head' }, [editable
      ? input('text', group.name, { maxlength: 30, disabled: busy, 'aria-label': `${index + 1}번째 모둠 이름`, class: 'groups-group-name' }, (value) => { group.name = value; markDirty(false); })
      : el('h3', { text: group.name }), el('span', { class: 'badge gray', text: `${group.studentIds.length}명` })]),
    el('ul', { class: 'groups-members' }, group.studentIds.map((id) => el('li', {}, [editable
      ? button(nameOf(id), () => { move.studentId = id; move.targetId = ''; move.swapId = ''; renderBoard(); }, { class: `groups-member${move.studentId === id ? ' selected' : ''}`, 'aria-pressed': move.studentId === id ? 'true' : 'false' })
      : el('span', { text: nameOf(id) })]))),
  ])));
}
function renderPreview() {
  const node = document.getElementById('groups-preview');
  if (!node) return;
  setChildren(node, el('div', { class: 'card-title' }, [el('h2', { text: '2. 새 후보 확인' }), el('span', { class: 'badge gray', text: '아직 편집안에 적용하지 않음' })]),
    preview?.candidate ? [
      el('p', { class: 'muted', text: `참여 ${preview.metrics.participants}명 · ${preview.metrics.groups}모둠 · 이전 활동과 반복되는 조합 ${preview.metrics.repeatedPairs}쌍` }),
      ...preview.warnings.map((warning) => el('div', { class: 'alert warn', text: warning })),
      groupCards(preview.candidate.groups),
      button('이 후보를 편집안에 적용', applyPreview, { class: 'btn primary', id: 'groups-apply-preview' }),
    ] : el('p', { class: 'muted', text: '위에서 조건을 정하고 후보를 만들어 보세요. 기존 편집안은 아래에 그대로 남아요.' }));
}
function renderBoard() {
  const node = document.getElementById('groups-editor');
  if (!node) return;
  const issue = localIssue();
  const all = (draft.groups || []).flatMap((group) => group.studentIds);
  const source = draft.groups.find((group) => group.studentIds.includes(move.studentId));
  const targets = draft.groups.filter((group) => group.id !== source?.id);
  const target = targets.find((group) => group.id === move.targetId);
  setChildren(node,
    el('div', { class: 'card-title' }, [el('h2', { text: '3. 편집하고 저장' }), el('span', { id: 'groups-save-state', class: `badge ${dirty ? 'orange' : 'green'}`, text: dirty ? '저장하지 않은 편집안' : editing ? '저장한 활동' : '새 활동' })]),
    issue ? el('div', { class: 'alert warn', text: issue }) : el('p', { class: 'muted', text: '모둠 이름을 고치거나 학생을 눌러 이동·맞바꾸기 할 수 있어요. 분리 조건과 균형은 계속 유지합니다.' }),
    draft.groups.length ? [groupCards(draft.groups, true),
      el('fieldset', { disabled: busy, class: 'groups-move' }, [
        el('legend', { text: '학생 이동 · 맞바꾸기' }),
        field('옮길 학생', select(move.studentId, [['', '학생 선택'], ...all.map((id) => [id, nameOf(id)])], { id: 'groups-move-student' }, (value) => { move = { studentId: value, targetId: '', swapId: '' }; renderBoard(); })),
        field('다른 모둠', select(move.targetId, [['', '모둠 선택'], ...targets.map((group) => [group.id, `${group.name} (${group.studentIds.length}명)`])], { id: 'groups-move-target' }, (value) => { move.targetId = value; move.swapId = ''; renderBoard(); })),
        field('이동 방법', select(move.swapId, [['', '빈자리로 이동'], ...(target?.studentIds || []).map((id) => [id, `${nameOf(id)} 학생과 맞바꾸기`])], { id: 'groups-move-swap' }, (value) => { move.swapId = value; })),
        button('편집안에 반영', moveStudent, { id: 'groups-move-apply', disabled: busy || !source || !target }),
        el('p', { class: 'muted', text: '인원이 같은 모둠끼리는 학생을 맞바꾸세요. 인원이 다른 경우 큰 모둠에서 작은 모둠으로 한 명을 옮길 수 있어요.' }),
      ]),
    ] : null,
    el('div', { class: 'btn-row' }, [
      button(editing ? '수정한 활동 저장' : '새 활동 저장', () => save(), { class: 'btn primary', id: 'groups-save', disabled: busy || Boolean(issue) }),
      editing ? button('편집안을 새 활동으로 저장', () => save(true), { id: 'groups-save-new', disabled: busy || Boolean(issue) }) : null,
      button('이름만 인쇄', () => { renderPrint(); window.print(); }, { id: 'groups-print-button', disabled: busy || Boolean(issue) }),
    ]),
    createUncertain ? el('div', { class: 'alert warn' }, [
      el('p', { text: '앞선 새 활동 저장이 완료됐는지 먼저 확인할 수 있어요. 같은 내용으로 다시 저장하면 같은 요청으로 처리해 중복 활동을 만들지 않습니다.' }),
      el('div', { class: 'btn-row' }, [button('앞서 저장한 활동 확인', recoverCreated, { id: 'groups-recover-created' }), button('별도 새 활동으로 저장', saveSeparateActivity, { id: 'groups-save-separate', disabled: busy || Boolean(issue) })]),
    ]) : null,
    el('p', { class: 'muted groups-print-help', text: '인쇄에는 모둠 번호와 학생 이름만 나와요. 결석 사유·분리 조건·편집 도구는 제외됩니다. 인쇄 설정에서 머리글/바닥글을 끄면 관리 주소도 출력되지 않아요.' }),
  );
  renderPrint();
}
function renderHistory() {
  return el('section', { class: 'card groups-history' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '저장한 활동' }), el('span', { class: 'muted', text: `${data.activities.length}/${data.limits.activities}개` }), button('최신 목록 읽기', () => load(), { id: 'groups-refresh', class: 'btn small' })]),
    el('p', { class: 'muted', text: '열기는 저장한 활동 수정, 복사는 기존 구성을 새 활동으로 가져오기예요. 이력을 삭제하면 반복 조합 계산에서도 제외됩니다.' }),
    data.activities.length ? el('ul', { class: 'groups-history-list' }, [...data.activities].sort((a, b) => b.activityDate.localeCompare(a.activityDate) || b.updatedAt.localeCompare(a.updatedAt)).map((activity) => el('li', { class: editing?.id === activity.id ? 'active' : '' }, [
      el('div', { class: 'groups-history-info' }, [el('b', { text: activity.title }), el('span', { class: 'muted', text: `${activity.activityDate} · ${data.rounds.find(({ id }) => id === activity.roundId)?.name || '삭제된 회차'} · ${activity.groups.length}모둠 · 수정 ${fmtDate(activity.updatedAt)}` })]),
      button('열기', () => openActivity(activity), { class: 'btn small' }), button('복사', () => openActivity(activity, true), { class: 'btn small' }), button('삭제', () => remove(activity), { class: 'btn small danger' }),
    ]))) : el('p', { class: 'muted', text: '아직 저장한 활동이 없어요. 편집안을 저장하면 여기에 쌓입니다.' }),
  ]);
}
function renderPrint() {
  const node = document.getElementById('groups-print');
  if (!node || !data) return;
  if (localIssue()) return setChildren(node, el('p', { text: '학생 편성을 완료한 뒤 인쇄해 주세요.' }));
  setChildren(node, el('h1', { text: '모둠·짝 편성' }), el('div', { class: 'groups-print-grid' }, draft.groups.map((group, index) => el('section', {}, [
    el('h2', { text: `${index + 1}모둠` }), el('ul', {}, group.studentIds.map((id) => el('li', { text: nameOf(id) }))),
  ]))));
}
function render() {
  if (!data) return;
  setChildren(app,
    el('section', { class: 'card groups-heading' }, [el('div', {}, [el('h1', { text: '모둠·짝 편성' }), el('p', { class: 'muted', text: `${data.room.name} · 수업마다 필요한 구성으로, 분리 조건은 지키고 반복 조합은 줄여요.` })]),
      button('새 활동', () => { if (!canLeaveDraft()) return; freshDraft(); notice = ''; render(); }, { id: 'groups-new' })]),
    el('div', { id: 'groups-notice', role: 'status', 'aria-live': 'polite' }),
    renderSettings(), el('section', { class: 'card', id: 'groups-preview' }), el('section', { class: 'card', id: 'groups-editor' }), renderHistory(),
    el('section', { id: 'groups-print', class: 'groups-print', 'aria-hidden': 'true' }),
  );
  renderNotice(); renderPreview(); renderBoard();
}

window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('beforeprint', renderPrint);
setupPageNav(token, initialRound);
void load({ initial: true });
