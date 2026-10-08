import { el, setChildren, fmtDate, setupPageNav, toast } from './common.js';

const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(token)}/followups`;
const app = document.getElementById('app');
const query = new URLSearchParams(location.search);
const storageKey = `teacher-followup-form:v1:${token}`;
let data = null;
let draft = null;
let dirty = false;
let busy = false;
let formError = '';
let conflict = null;
let notice = '';
let listError = '';
const filters = { student: query.get('student') || '', status: query.get('status') || 'open', due: query.get('due') || 'all' };

setupPageNav(token);
const nameOf = (id) => data.students.find((s) => s.id === id)?.name || '삭제된 학생';
const newMutationId = () => crypto.randomUUID();
const blank = () => ({ id: null, expectedVersion: null, studentIds: data.students.some((s) => s.id === filters.student) ? [filters.student] : [], observedDate: data.today, observation: '', action: '', nextCheckDate: '', status: 'open' });
const fromEntry = (entry) => ({ id: entry.id, expectedVersion: entry.version, studentIds: [...entry.studentIds], observedDate: entry.observedDate, observation: entry.observation, action: entry.action, nextCheckDate: entry.nextCheckDate || '', status: entry.status });

async function request(method = 'GET', suffix = '', body) {
  const response = await fetch(base + suffix, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json();
  if (!response.ok) throw Object.assign(new Error(json.error || `요청 실패 (${response.status})`), { status: response.status, entry: json.entry, code: json.code });
  return json;
}

function persistDraft() {
  try {
    if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ draft, savedAt: Date.now() }));
    else sessionStorage.removeItem(storageKey);
  } catch {
    notice = '이 브라우저에서는 작성 중인 내용을 임시 보관할 수 없어요. 페이지를 닫기 전에 저장해 주세요.';
    const status = document.getElementById('followup-notice');
    if (status) status.textContent = notice;
  }
}

function changed(key, value) {
  draft[key] = value;
  dirty = true;
  persistDraft();
  const status = document.getElementById('followup-draft-state');
  if (status) status.textContent = '작성 중 · 아직 교실에 저장하지 않았어요.';
}

function resetDraft() {
  draft = blank(); dirty = false; formError = ''; conflict = null;
  persistDraft();
}

function confirmDiscard() {
  return !dirty || confirm('아직 저장하지 않은 작성 내용이 있어요. 이 내용을 버리고 이동할까요?');
}

function openEntry(entry) {
  if (!confirmDiscard()) return;
  draft = fromEntry(entry); dirty = false; formError = ''; conflict = null; notice = '';
  persistDraft(); render(); focusForm();
}

function focusForm() {
  const title = document.getElementById('followup-form-title');
  title?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  title?.focus({ preventScroll: true });
}

function acceptData(next) {
  data = next;
  if (draft?.id) {
    const latest = data.entries.find((entry) => entry.id === draft.id);
    if (!latest || latest.version !== draft.expectedVersion) {
      conflict = latest || { removed: true };
      formError = latest ? '다른 창에서 이 기록을 바꿨어요. 아래 최신 기록과 비교해 주세요. 작성 중인 내용은 그대로 남아 있어요.' : '이 기록은 삭제되었거나 보관 기간이 끝났어요. 작성 중인 내용은 그대로 남아 있어요.';
    }
  }
}

async function reloadList() {
  if (busy) return;
  busy = true; listError = ''; render();
  try { acceptData(await request()); notice = '목록을 새로 확인했어요. 작성 중인 내용은 유지했어요.'; }
  catch (error) { listError = error.message; }
  finally { busy = false; render(); }
}

async function save(event) {
  event.preventDefault();
  if (busy) return;
  if (!draft.studentIds.length) { formError = '해당 학생을 한 명 이상 골라 주세요.'; render(); focusForm(); return; }
  if (!draft.id && !draft.clientMutationId) { draft.clientMutationId = newMutationId(); dirty = true; persistDraft(); }
  busy = true; formError = ''; listError = ''; render();
  try {
    const { id, expectedVersion, ...fields } = draft;
    const next = await request(id ? 'PUT' : 'POST', id ? `/${encodeURIComponent(id)}` : '', { ...fields, ...(id ? { expectedVersion } : {}) });
    data = next; resetDraft(); notice = '기록을 저장했어요. 학생 화면에는 공개되지 않아요.';
    toast('상담·관찰 기록을 저장했어요.');
  } catch (error) {
    formError = error.message;
    if (error.entry) conflict = error.entry;
    else if (error.code === 'FOLLOWUP_REMOVED') conflict = { removed: true };
    persistDraft();
  } finally { busy = false; render(); }
}

async function changeStatus(entry) {
  if (busy) return;
  busy = true; listError = ''; render();
  try {
    acceptData(await request('PUT', `/${encodeURIComponent(entry.id)}`, { expectedVersion: entry.version, status: entry.status === 'open' ? 'completed' : 'open' }));
    toast(entry.status === 'open' ? '확인 완료로 표시했어요.' : '다시 확인할 목록에 넣었어요.');
  } catch (error) { listError = `${error.message} 목록 새로 확인을 눌러 최신 기록을 볼 수 있어요.`; }
  finally { busy = false; render(); }
}

async function removeEntry(entry) {
  if (busy || !confirm(`${entry.observedDate} · ${entry.studentIds.map(nameOf).join(', ')} 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없어요.`)) return;
  if (draft.id === entry.id && dirty && !confirmDiscard()) return;
  busy = true; listError = ''; render();
  try {
    const next = await request('DELETE', `/${encodeURIComponent(entry.id)}`, { expectedVersion: entry.version });
    if (draft.id === entry.id) resetDraft();
    acceptData(next); toast('기록을 삭제했어요.');
  } catch (error) { listError = `${error.message} 작성 중인 내용은 그대로 남아 있어요.`; }
  finally { busy = false; render(); }
}

function field(label, key, attrs = {}) {
  const id = `followup-${key}`;
  const input = el(attrs.rows ? 'textarea' : 'input', { id, name: key, ...attrs, onInput: (event) => changed(key, event.target.value) });
  input.value = draft[key];
  return el('div', { class: 'followup-field' }, [el('label', { for: id, text: label }), input]);
}

function recordContent(entry) {
  return el('div', { class: 'followup-content' }, [
    el('h4', { text: '관찰·상담 내용' }), el('p', { text: entry.observation }),
    entry.action ? el('h4', { text: '한 일·도움' }) : null, entry.action ? el('p', { text: entry.action }) : null,
    el('div', { class: 'muted', text: `수정 ${fmtDate(entry.updatedAt)}${entry.completedAt ? ` · 확인 완료 ${fmtDate(entry.completedAt)}` : ''}` }),
  ]);
}

function conflictPanel() {
  if (!conflict) return null;
  const fresh = !conflict.removed;
  return el('div', { class: 'alert warn followup-conflict', role: 'alert' }, [
    el('h3', { text: fresh ? '서버에 저장된 최신 기록' : '원래 기록을 찾을 수 없어요' }),
    fresh ? el('div', { text: `${conflict.observedDate} · ${conflict.studentIds.map(nameOf).join(', ')} · ${conflict.status === 'completed' ? '확인 완료' : '확인 중'} · 다음 확인 ${conflict.nextCheckDate || '미정'}` }) : null,
    fresh ? recordContent(conflict) : el('p', { text: '아래에 남아 있는 작성 내용을 새 기록으로 저장할 수 있어요.' }),
    el('div', { class: 'btn-row' }, [
      fresh ? el('button', { type: 'button', class: 'btn', text: '최신 기록을 폼에 불러오기', onClick: () => {
        if (!confirm('내가 작성한 내용을 버리고 서버의 최신 기록을 불러올까요?')) return;
        draft = fromEntry(conflict); dirty = false; conflict = null; formError = ''; persistDraft(); render();
      } }) : null,
      el('button', { type: 'button', class: 'btn', text: '내 내용을 새 기록으로 작성', onClick: () => {
        if (!confirm('원래 기록은 바꾸지 않고, 현재 작성한 내용을 별도 기록으로 저장할 준비를 할까요?')) return;
        draft.id = null; draft.expectedVersion = null; delete draft.clientMutationId; dirty = true; conflict = null; formError = ''; persistDraft(); render();
      } }),
    ]),
  ]);
}

function editor() {
  const status = el('select', { id: 'followup-status', onChange: (event) => changed('status', event.target.value) }, [el('option', { value: 'open', text: '확인 중' }), el('option', { value: 'completed', text: '확인 완료' })]);
  status.value = draft.status;
  const selected = new Set(draft.studentIds);
  const students = data.students.map((student) => el('label', { class: 'followup-student' }, [el('input', { type: 'checkbox', value: student.id, checked: selected.has(student.id), onChange: (event) => {
    const ids = new Set(draft.studentIds); event.target.checked ? ids.add(student.id) : ids.delete(student.id); changed('studentIds', [...ids]);
  } }), student.name]));
  const missing = draft.studentIds.filter((id) => !data.students.some((s) => s.id === id));
  return el('section', { class: 'card followup-editor' }, [
    el('h2', { id: 'followup-form-title', tabindex: -1, text: draft.id ? '기록 수정' : '새 상담·관찰 기록' }),
    el('p', { id: 'followup-draft-state', class: 'muted', role: 'status', 'aria-live': 'polite', text: dirty ? '작성 중 · 아직 교실에 저장하지 않았어요.' : '관찰한 사실과 실제로 한 일을 짧게 적어 주세요.' }),
    el('form', { id: 'followup-form', onSubmit: save }, [el('fieldset', { class: 'followup-form-fields', disabled: busy }, [
      formError ? el('div', { class: 'alert error', role: 'alert', text: formError }) : null,
      conflictPanel(),
      el('fieldset', { class: 'followup-students' }, [el('legend', { text: '해당 학생 (한 명 이상)' }), el('div', { class: 'followup-student-options' }, students),
        missing.length ? el('div', { class: 'alert warn' }, [el('p', { text: '삭제된 학생이 작성 중인 기록에 포함되어 있어요. 남은 학생만 다시 골라 주세요.' }), el('button', { type: 'button', class: 'btn small', text: '삭제된 학생 선택 해제', onClick: () => { changed('studentIds', draft.studentIds.filter((id) => !missing.includes(id))); render(); } })]) : null,
      ]),
      el('div', { class: 'followup-date-fields' }, [field('관찰·상담 날짜 *', 'observedDate', { type: 'date', required: true, max: data.today }), field('다음 확인일 (선택)', 'nextCheckDate', { type: 'date' })]),
      field('관찰·상담 내용 *', 'observation', { rows: 4, maxlength: 2000, required: true, placeholder: '예: 쉬는 시간에 함께 놀이에 참여하기 어려웠다고 이야기함.' }),
      field('한 일·도움 (선택)', 'action', { rows: 3, maxlength: 2000, placeholder: '예: 학생의 이야기를 듣고, 다음 모둠 활동 후 다시 이야기하기로 함.' }),
      el('div', { class: 'followup-field' }, [el('label', { for: 'followup-status', text: '확인 상태' }), status]),
      el('div', { class: 'btn-row' }, [el('button', { type: 'submit', class: 'btn primary', disabled: Boolean(conflict), text: busy ? '저장 중…' : '기록 저장' }),
        el('button', { type: 'button', class: 'btn', text: '작성 취소', onClick: () => { if (confirmDiscard()) { resetDraft(); notice = ''; render(); } } }),
      ]),
    ])]),
  ]);
}

function dueKind(entry) {
  if (entry.status === 'completed') return 'completed';
  return !entry.nextCheckDate ? 'unscheduled' : entry.nextCheckDate < data.today ? 'overdue' : entry.nextCheckDate === data.today ? 'today' : 'upcoming';
}
const dueNames = { completed: '확인 완료', unscheduled: '확인일 미정', overdue: '확인일 지남', today: '오늘 확인', upcoming: '확인 예정' };

function filterControl(label, key, options) {
  const id = `followup-filter-${key}`;
  const select = el('select', { id, onChange: (event) => { filters[key] = event.target.value; render(); } }, options.map(([value, text]) => el('option', { value, text })));
  select.value = filters[key];
  return el('div', { class: 'followup-field' }, [el('label', { for: id, text: label }), select]);
}

function timeline() {
  const entries = data.entries.filter((entry) => (!filters.student || entry.studentIds.includes(filters.student)) && (filters.status === 'all' || entry.status === filters.status) && (filters.due === 'all' || dueKind(entry) === filters.due));
  return el('section', { class: 'card followup-timeline' }, [
    el('div', { class: 'followup-heading' }, [el('h2', { text: '날짜별 기록' }), el('button', { class: 'btn small', type: 'button', disabled: busy, text: '목록 새로 확인', onClick: reloadList })]),
    el('div', { class: 'followup-filters' }, [filterControl('학생', 'student', [['', '전체 학생'], ...data.students.map((s) => [s.id, s.name])]), filterControl('상태', 'status', [['all', '전체'], ['open', '확인 중'], ['completed', '확인 완료']]), filterControl('확인일', 'due', [['all', '전체'], ['overdue', '확인일 지남'], ['today', '오늘 확인'], ['upcoming', '확인 예정'], ['unscheduled', '확인일 미정']])]),
    listError ? el('div', { class: 'alert error', role: 'alert', text: listError }) : null,
    el('p', { class: 'muted', text: `${entries.length}개 기록 · 관찰·상담 날짜가 최근인 순서` }),
    entries.length ? el('ol', { class: 'followup-records' }, entries.map((entry) => el('li', { class: `followup-record followup-${dueKind(entry)}`, id: `record-${entry.id}` }, [
      el('div', { class: 'followup-heading' }, [el('h3', { text: `${entry.observedDate} · ${entry.studentIds.map(nameOf).join(', ')}` }), el('span', { class: `badge ${dueKind(entry) === 'overdue' ? 'warn' : entry.status === 'completed' ? 'green' : 'blue'}`, text: `${dueNames[dueKind(entry)]}${entry.nextCheckDate ? ` · ${entry.nextCheckDate}` : ''}` })]),
      recordContent(entry), el('div', { class: 'btn-row' }, [el('button', { class: 'btn small', type: 'button', disabled: busy, text: '수정', onClick: () => openEntry(entry) }), el('button', { class: 'btn small', type: 'button', disabled: busy || draft.id === entry.id, title: draft.id === entry.id ? '수정 중인 기록은 폼에서 상태를 바꾸고 저장해 주세요.' : null, text: entry.status === 'open' ? '확인 완료' : '다시 확인하기', onClick: () => changeStatus(entry) }), el('button', { class: 'btn small danger', type: 'button', disabled: busy, text: '삭제', onClick: () => removeEntry(entry) })]),
    ]))) : el('p', { class: 'muted', text: data.entries.length ? '이 조건에 맞는 기록이 없어요. 필터를 바꾸면 다른 기록을 볼 수 있어요.' : '아직 기록이 없어요. 학생과 이야기하거나 관찰한 내용을 첫 기록으로 남겨 보세요.' }),
  ]);
}

function render() {
  if (!data) return;
  document.title = `${data.room.name} · 상담·관찰 후속 확인`;
  setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '상담·관찰 후속 확인' }), el('p', { text: `${data.room.name} · 학생과 이야기한 내용과 다음에 확인할 일을 한곳에서 살펴봐요.` }), el('div', { class: 'alert info', text: '교사 전용 기록이에요. 학생 화면·AI 분석·종합 보고서에는 포함되지 않아요. 작성 중인 내용은 저장할 때까지 이 탭에만 임시로 보관돼요.' }), el('p', { id: 'followup-notice', role: 'status', 'aria-live': 'polite', class: 'muted', text: notice })]), el('div', { class: 'followup-layout' }, [editor(), timeline()]));
}

window.addEventListener('beforeunload', (event) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  try {
    data = await request(); draft = blank();
    const target = data.entries.find((entry) => entry.id === query.get('edit'));
    if (target) draft = fromEntry(target);
    try {
      const backup = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (backup?.draft && typeof backup.savedAt === 'number' && Date.now() - backup.savedAt < 7 * 86400000 && Array.isArray(backup.draft.studentIds)) {
        draft = backup.draft; dirty = true; notice = '이 탭에서 저장하지 않았던 작성 내용을 복원했어요. 아직 교실에 저장한 기록은 아니에요.';
      } else sessionStorage.removeItem(storageKey);
    } catch { /* Unavailable/corrupt tab backup does not prevent reading saved records. */ }
    acceptData(data); render();
    if (target) focusForm();
  } catch (error) {
    setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '상담·관찰 기록을 열지 못했어요' }), el('p', { class: 'alert error', role: 'alert', text: error.message }), el('button', { class: 'btn', type: 'button', text: '다시 열기', onClick: init })]));
  }
}
init();
