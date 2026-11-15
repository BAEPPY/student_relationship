// 학생별 상담 보고서 페이지 (/t/:adminToken/student-report?sid=…). 한 학생의 회차별 변화 · 관계 상세 · 돌아보기 · 상담 기록과
// (선택) AI 상담 도움말을 한 문서로 보여 주고, 인쇄 · 한글 · 워드로 내보내요. 문서 모델은 서버(server/student-report.js)가 만들어요.
import { api, el, toast, setChildren, setupPageNav } from './common.js';
import { renderDocument } from './report-render.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');

let students = [];                                               // [{ id, name }]
let sid = new URLSearchParams(location.search).get('sid');       // 보고 있는 학생
let withFollowups = true;                                        // 상담·관찰 기록 넣기
let withAi = true;                                               // AI 상담 도움말 넣기
let meta = null;                                                 // 마지막으로 받은 { aiReport, ai }
let aiBusy = false;
let loading = 0;                                                 // 늦게 도착한 응답을 버리기 위한 번호표

setupPageNav(adminToken);

const nameOf = (id) => students.find((s) => s.id === id)?.name || '';
const AI_CONFIRM = 'AI 상담 도움말은 30초~1분 걸리고 API 사용량(비용)이 들어요. 이 학생의 회차별 응답·돌아보기·선생님 메모·상담 기록을 가명으로 바꿔 보내고, 결과는 이 학생 보고서에 보관돼요. 계속할까요?';
const reportQuery = () => {
  const p = new URLSearchParams();
  if (!withFollowups) p.set('followups', '0');
  if (!withAi) p.set('ai', '0');
  const q = p.toString();
  return q ? `?${q}` : '';
};
const studentUrl = (id, suffix) => `${base}/students/${encodeURIComponent(id)}/${suffix}`;

function setStudent(id) {
  sid = id;
  try { history.replaceState(null, '', `${location.pathname}?sid=${encodeURIComponent(sid)}`); } catch { /* 주소를 못 바꿔도 보는 데는 지장 없음 */ }
  loadReport();
}

// ---------- 조절 줄 (학생 고르기 · 넣을 내용 · AI) ----------
function renderControls() {
  const idx = students.findIndex((s) => s.id === sid);
  const select = el('select', { class: 'select', id: 'student-select', 'aria-label': '보고서를 볼 학생' }, students.map((s, i) => el('option', {
    value: s.id, selected: s.id === sid ? true : null, text: `${i + 1}. ${s.name}`,
  })));
  select.addEventListener('change', () => setStudent(select.value));
  const step = (dir, text) => el('button', {
    type: 'button', class: 'btn small', id: dir < 0 ? 'prev-student' : 'next-student', text,
    disabled: students.length < 2 ? true : null,
    onClick: () => setStudent(students[(idx + dir + students.length) % students.length].id),
  });
  const ai = meta?.aiReport || null;
  const aiEnabled = Boolean(meta?.ai?.enabled);
  const aiStatus = ai
    ? `AI 상담 도움말: ${String(ai.createdAt || '').slice(0, 10)} 만듦${ai.stale ? ' · 그 뒤 자료가 바뀌었어요' : ''}${ai.truncated ? ' · 자료가 길어 일부 생략됨' : ''}`
    : aiEnabled ? 'AI 상담 도움말이 아직 없어요.' : 'AI 상담 도움말은 서버에 ANTHROPIC_API_KEY 를 설정하면 쓸 수 있어요.';
  return el('div', { class: 'card report-controls no-print', id: 'report-controls' }, [
    el('div', { class: 'control-row' }, [
      el('label', { for: 'student-select' }, [el('b', { text: '학생' }), select]),
      step(-1, '◀ 이전 학생'), step(1, '다음 학생 ▶'),
      el('span', { class: 'muted', text: `${idx + 1} / ${students.length}명` }),
    ]),
    el('div', { class: 'control-row' }, [
      el('label', {}, [
        el('input', { type: 'checkbox', id: 'opt-followups', checked: withFollowups ? true : null, onChange: (e) => { withFollowups = e.target.checked; loadReport(); } }),
        '상담·관찰 기록 넣기',
      ]),
      el('label', {}, [
        el('input', { type: 'checkbox', id: 'opt-ai', checked: withAi ? true : null, onChange: (e) => { withAi = e.target.checked; loadReport(); } }),
        'AI 상담 도움말 넣기',
      ]),
    ]),
    el('div', { class: 'control-row ai-row' }, [
      el('button', {
        type: 'button', class: 'btn primary', id: 'ai-report-btn', disabled: aiEnabled && !aiBusy ? null : true,
        text: aiBusy ? 'AI가 쓰는 중…' : ai ? '🤖 AI 상담 도움말 다시 만들기' : '🤖 AI 상담 도움말 만들기',
        title: aiEnabled ? '관심 둘 점 · 학생 상담 방법 · 학부모 상담 멘트를 만들어요 (30초~1분, API 비용)' : 'AI 를 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.',
        onClick: runAi,
      }),
      ai ? el('button', { type: 'button', class: 'btn small', id: 'ai-report-delete', disabled: aiBusy ? true : null, text: 'AI 도움말 지우기', onClick: deleteAi }) : null,
      el('span', { class: `muted ai-status${ai?.stale ? ' stale' : ''}`, id: 'ai-report-status', role: 'status', text: aiStatus }),
    ]),
    el('span', { class: 'muted', text: '인쇄하면 위쪽 메뉴와 이 줄은 빠지고 문서만 나와요. 학부모 상담에 가져갈 때는 "상담·관찰 기록 넣기"를 끄고 뽑을 수 있어요. 🔒 AI 에는 이름을 S1, S2 같은 가명으로 바꿔 보내요.' }),
  ]);
}

function showError(message) {
  setChildren(app, el('section', { class: 'card report-error' }, [
    el('div', { class: 'alert error', text: message }),
    el('div', { class: 'btn-row' }, [el('a', { class: 'btn', href: `/t/${encodeURIComponent(adminToken)}`, text: '선생님 페이지로' })]),
  ]));
}

function show(doc) {
  meta = { aiReport: doc.aiReport || null, ai: doc.ai || null };
  setChildren(app, renderControls(), renderDocument(doc));
  document.title = `${doc.title || '학생 보고서'} · 학생 관계 마인드맵`;
}

// ---------- 데이터 ----------
async function loadReport() {
  const seq = ++loading;
  setChildren(app, renderControls(), el('div', { class: 'card', id: 'loading', text: '보고서를 만드는 중…' }));
  try {
    const doc = await api(`${studentUrl(sid, 'report.json')}${reportQuery()}`);
    if (seq !== loading) return;   // 그 사이 다른 학생을 골랐으면 버려요
    show(doc);
  } catch (err) {
    if (seq !== loading) return;
    setChildren(app, renderControls(), el('section', { class: 'card report-error' }, [el('div', { class: 'alert error', text: err.message || '보고서를 만들지 못했어요.' })]));
  }
}

async function runAi() {
  if (aiBusy || !meta?.ai?.enabled) return;
  if (!confirm(AI_CONFIRM)) return;
  const target = sid;
  aiBusy = true;
  document.getElementById('report-controls')?.replaceWith(renderControls());
  try {
    const doc = await api(`${studentUrl(target, 'ai-report')}${reportQuery()}`, { method: 'POST' });
    aiBusy = false;
    if (target !== sid) { toast(`${nameOf(target)} 학생의 AI 상담 도움말을 만들었어요.`, 4000); document.getElementById('report-controls')?.replaceWith(renderControls()); return; }
    withAi = true;
    show(doc);
    toast('AI 상담 도움말을 만들었어요. 문서 아래쪽 "AI 상담 도움말"을 확인해 주세요.', 5000);
    document.querySelector('.report-doc h2:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    aiBusy = false;
    document.getElementById('report-controls')?.replaceWith(renderControls());
    toast(err.message || 'AI 상담 도움말을 만들지 못했어요.', 5000);
  }
}

async function deleteAi() {
  if (aiBusy || !confirm(`${nameOf(sid)} 학생의 AI 상담 도움말을 지울까요? 다시 만들 수 있어요.`)) return;
  try {
    show(await api(`${studentUrl(sid, 'ai-report')}${reportQuery()}`, { method: 'DELETE' }));
    toast('AI 상담 도움말을 지웠어요.');
  } catch (err) { toast(err.message, 4500); }
}

/** 한글(hwpx)·워드(docx) 파일로 받아요. */
async function downloadFile(kind, btn) {
  if (!sid) return;
  const name = `학생보고서_${(nameOf(sid) || '학생').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.${kind}`;
  if (btn) btn.disabled = true;
  toast(`${kind === 'hwpx' ? '한글' : '워드'} 파일을 만드는 중…`, 1500);
  try {
    const res = await fetch(`${studentUrl(sid, `report.${kind}`)}${reportQuery()}`);
    if (!res.ok) {
      let msg = `파일을 만들지 못했어요 (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    toast(`${name} 파일을 내려받았어요.`, 4000);
  } catch (err) {
    toast(err.message, 4500);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function init() {
  document.getElementById('print-btn')?.addEventListener('click', () => window.print());
  document.getElementById('dl-hwpx')?.addEventListener('click', (e) => downloadFile('hwpx', e.currentTarget));
  document.getElementById('dl-docx')?.addEventListener('click', (e) => downloadFile('docx', e.currentTarget));
  let view;
  try {
    view = await api(base);
  } catch (err) {
    return showError(err.status === 404 ? '교실을 찾을 수 없어요' : (err.message || '교실을 열 수 없어요.'));
  }
  students = (view.students || []).map((s) => ({ id: s.id, name: s.name }));
  meta = { aiReport: null, ai: view.ai || null };
  if (!students.length) return showError('학생이 없어요. 선생님 페이지에서 학생을 먼저 등록해 주세요.');
  if (!sid || !students.some((s) => s.id === sid)) {
    const missing = Boolean(sid);
    sid = students[0].id;
    try { history.replaceState(null, '', `${location.pathname}?sid=${encodeURIComponent(sid)}`); } catch { /* 무시 */ }
    if (missing) toast('그 학생을 찾을 수 없어 첫 번째 학생을 열었어요.', 4000);
  }
  await loadReport();
}

init();
