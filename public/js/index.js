import { api, el, toast, copyText, savedRooms, fmtDate, mascotSvg } from './common.js';

const form = document.getElementById('create-form');
const nameInput = document.getElementById('room-name');
const studentsInput = document.getElementById('students');
const minGoodInput = document.getElementById('min-good');
const minBadInput = document.getElementById('min-bad');
const introInput = document.getElementById('intro-kind');   // 🌱 새 학기 첫 조사로 시작하기
const errorBox = document.getElementById('create-error');
const createBtn = document.getElementById('create-btn');
const demoBtn = document.getElementById('demo-btn');
const resultCard = document.getElementById('result-card');
const adminUrlInput = document.getElementById('admin-url');
const goTeacher = document.getElementById('go-teacher');
const countLabel = document.getElementById('student-count');
const rosterBtn = document.getElementById('roster-file-btn');
const rosterNotice = document.getElementById('roster-notice');

function parseNames(text) {
  return text.split(/[\n,、，;]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function updateCount() {
  const n = parseNames(studentsInput.value).length;
  countLabel.textContent = n ? `현재 ${n}명` : '';
}
studentsInput.addEventListener('input', updateCount);

// 3월(한국 시간)에는 '새 학기 첫 조사로 시작하기'를 미리 켜 둬요. 선생님이 끌 수 있어요
if (new Date(Date.now() + 9 * 3600 * 1000).getUTCMonth() === 2) {
  introInput.checked = true;
  document.getElementById('intro-kind-hint').textContent = '3월이라 미리 켜 두었어요.';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.toggle('hidden', !msg);
}

/** 명단 파일에서 읽은 뒤의 안내(경고)는 오류가 아니라 확인 거리로 보여 줍니다. */
function showRosterNotice(lines) {
  const list = (lines || []).filter(Boolean);
  rosterNotice.replaceChildren(...list.map((t) => el('div', { text: t })));
  rosterNotice.classList.toggle('hidden', !list.length);
}

// ---------- 명단 파일 올리기 (한글·워드·텍스트) ----------
const FILE_ACCEPT = '.hwp,.hwpx,.docx,.txt,.csv';

/** 파일 선택 창을 열고 고른 파일을 돌려줍니다 (취소하면 null). */
function pickFile(accept = FILE_ACCEPT) {
  return new Promise((resolve) => {
    const inp = el('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve(inp.files?.[0] || null); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve(null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

/** 파일을 그대로 올리고 JSON 응답을 돌려줍니다. 파일 내용은 서버 메모리에서만 읽고 저장하지 않아요. */
async function uploadFile(url, file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('파일이 너무 커요. (최대 6MB)');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new Error(data?.error || `파일을 읽지 못했어요 (${res.status})`);
  return data;
}

async function importRosterFile() {
  const file = await pickFile();
  if (!file) return;
  rosterBtn.disabled = true;
  showRosterNotice([]);
  try {
    const result = await uploadFile('/api/roster/parse', file);
    const found = Array.isArray(result.names) ? result.names : [];
    if (!found.length) {
      showRosterNotice(result.warnings?.length ? result.warnings : ['명단을 찾지 못했어요.']);
      toast(`"${file.name}"에서 이름을 찾지 못했어요.`, 4000);
      return;
    }
    const existing = parseNames(studentsInput.value);
    let names = found;
    let added = found.length;
    if (existing.length) {
      const replace = confirm(`이미 적어 둔 학생 ${existing.length}명이 있어요.\n\n[확인] 파일에서 읽은 ${found.length}명으로 바꾸기\n[취소] 지금 목록 뒤에 덧붙이기 (이미 있는 이름은 건너뜀)`);
      if (!replace) {
        const have = new Set(existing);
        const extra = found.filter((n) => !have.has(n));
        names = [...existing, ...extra];
        added = extra.length;
      }
    }
    studentsInput.value = names.join('\n');
    updateCount();
    showError('');
    showRosterNotice(result.warnings || []);
    const summary = added === found.length ? `${found.length}명을 읽었어요.` : `${found.length}명을 읽어 ${added}명을 덧붙였어요.`;
    toast(`"${file.name}"에서 ${summary} 확인한 뒤 교실을 만들어 주세요.`, 4500);
    studentsInput.focus();
  } catch (err) {
    toast(err.message, 4500);
  } finally {
    rosterBtn.disabled = false;
  }
}
rosterBtn.addEventListener('click', importRosterFile);

function showResult(room, { title = '교실이 만들어졌어요 🎉', notes = [] } = {}) {
  savedRooms.add(room);
  adminUrlInput.value = room.adminUrl;
  goTeacher.href = `/t/${room.adminToken}`;
  document.getElementById('result-title').textContent = title;
  const noteBox = document.getElementById('result-note');
  noteBox.replaceChildren(...notes.filter(Boolean).map((t) => el('div', { text: t })));
  noteBox.classList.toggle('hidden', !notes.filter(Boolean).length);
  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth' });
  renderSaved();
}

// ---------- JSON 파일로 가져오기 (그대로 복원 · 새 학년 교실로 시작) ----------
const importBtn = document.getElementById('import-file-btn');
const importError = document.getElementById('import-error');
const importPreview = document.getElementById('import-preview');
const carryBox = document.getElementById('carry-roles');
const IMPORT_MAX_BYTES = 3.9 * 1024 * 1024;   // 서버가 받는 복원 본문은 4MB 까지
let carriedRoles = null;                       // 새 학년 교실에 함께 가져갈 1인 1역 역할 목록 (없으면 null)

function showImportError(msg) {
  importError.textContent = msg || '';
  importError.classList.toggle('hidden', !msg);
}

/** 내보내기 파일에서 미리 보여 줄 내용을 뽑아요. 새 형식은 backup(복원용 원본), 예전 형식은 화면용 자료에서 읽어요. */
function describeExport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const backup = data.backup && typeof data.backup === 'object' && data.backup.room && typeof data.backup.room === 'object' ? data.backup : null;
  const src = backup ? backup.room : data;
  const room = backup ? backup.room : data.room;
  const list = (v) => (Array.isArray(v) ? v : []);
  const students = list(src.students).map((s) => String(s?.name ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rounds = list(src.rounds).map((r) => String(r?.name ?? '').trim()).filter(Boolean);
  const roles = list(src.roles).filter((r) => r && typeof r === 'object' && String(r.name ?? '').trim())
    .map((r) => ({ name: String(r.name), subtitle: String(r.subtitle ?? ''), slots: Number(r.slots) || 1, description: String(r.description ?? '') }));
  const name = String(room?.name ?? '').trim();
  if (!name || !students.length) return null;
  const num = (v, fallback) => (Number.isInteger(v) && v >= 0 && v <= 10 ? v : fallback);
  return { backup, name, students, rounds, roles, minGood: num(room?.minGood, 3), minBad: num(room?.minBad, 1), exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null };
}

function renderCarried() {
  if (!carriedRoles?.length) { carryBox.classList.add('hidden'); carryBox.replaceChildren(); return; }
  carryBox.replaceChildren(
    el('div', {}, [el('b', { text: `📋 1인 1역 역할 ${carriedRoles.length}개를 새 교실에 함께 가져가요.` })]),
    el('div', { class: 'muted', text: carriedRoles.map((r) => r.name).join(', ') }),
    el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn small', id: 'carry-roles-drop', text: '역할은 가져가지 않기', onClick: () => { carriedRoles = null; renderCarried(); } }),
    ]),
  );
  carryBox.classList.remove('hidden');
}

/** 새 학년 교실로 시작: 응답은 두고 교실 이름 · 표시 수 · 역할 목록(선택: 명단)만 '교실 만들기' 칸에 채워요. */
function carryOver(info, withRoster) {
  nameInput.value = info.name;
  minGoodInput.value = info.minGood;
  minBadInput.value = info.minBad;
  if (withRoster) { studentsInput.value = info.students.join('\n'); updateCount(); }
  // 새 학생들과 시작하는 새 학년 교실이면 첫 조사는 '새 학기 첫 조사'가 어울리고, 같은 학생들로 다시 시작하면 평소 조사예요 (선생님이 바꿀 수 있어요)
  introInput.checked = !withRoster;
  carriedRoles = info.roles.length ? info.roles : null;
  renderCarried();
  showError('');
  document.getElementById('create-card').scrollIntoView({ behavior: 'smooth' });
  (withRoster ? nameInput : studentsInput).focus({ preventScroll: true });
  toast(withRoster ? '지난 교실의 이름 · 명단 · 설정을 채웠어요. 확인하고 "교실 만들기"를 눌러 주세요.' : '교실 이름과 설정을 채우고 "새 학기 첫 조사로 시작하기"를 켰어요. 새 학생 명단을 적고 "교실 만들기"를 눌러 주세요.', 5000);
}

async function restoreFromFile(info, btn) {
  if (!info.backup) return;
  if (!confirm(`"${info.name}" 교실을 이 파일로 복원할까요?\n\n· 학생 ${info.students.length}명, 회차 ${info.rounds.length}개의 응답 · 메모 · 자리표 · 1인 1역이 새 교실로 되살아나요.\n· 선생님 링크와 학생 QR 은 새로 만들어져요 (QR 을 다시 나눠 줘야 해요).\n· 원래 교실이 남아 있다면 그대로 두고 교실이 하나 더 생겨요.`)) return;
  if (new Blob([JSON.stringify({ backup: info.backup })]).size > IMPORT_MAX_BYTES) return showImportError('파일이 너무 커서 복원할 수 없어요. (4MB 까지)');
  btn.disabled = true;
  showImportError('');
  try {
    const room = await api('/api/rooms/import', { method: 'POST', body: { backup: info.backup } });
    importPreview.classList.add('hidden');
    importPreview.replaceChildren();
    showResult(room, {
      title: '교실을 복원했어요 🎉',
      notes: [
        `학생 ${room.studentCount}명 · 회차 ${room.roundCount}개를 되살렸어요.`,
        '학생 링크(QR)가 새로 만들어졌어요. 선생님 페이지의 "QR 인쇄"에서 다시 뽑아 나눠 주세요. 예전 QR 로는 이 교실에 들어올 수 없어요.',
        room.droppedRounds ? `보관 기간(14개월)이 지난 회차 ${room.droppedRounds}개는 복원하지 않았어요.` : '',
      ],
    });
    toast('교실을 복원했어요.');
  } catch (err) {
    showImportError(err.message || '복원하지 못했어요.');
  } finally {
    btn.disabled = false;
  }
}

function renderImportPreview(info, fileName) {
  const withRoster = el('input', { type: 'checkbox', id: 'import-with-roster' });
  const restoreBtn = el('button', { type: 'button', class: 'btn primary', id: 'import-restore-btn', text: '📦 이 파일로 교실 복원하기', disabled: info.backup ? null : true });
  restoreBtn.addEventListener('click', () => restoreFromFile(info, restoreBtn));
  importPreview.replaceChildren(
    el('div', { class: 'import-summary' }, [
      el('div', {}, [el('b', { text: info.name }), el('span', { class: 'muted', text: ` · ${fileName}` })]),
      el('div', { class: 'muted', text: [
        `학생 ${info.students.length}명`,
        `회차 ${info.rounds.length}개${info.rounds.length ? ` (${info.rounds.slice(-4).join(', ')}${info.rounds.length > 4 ? ' …' : ''})` : ''}`,
        info.roles.length ? `1인 1역 역할 ${info.roles.length}개` : '',
        info.exportedAt ? `내보낸 날 ${fmtDate(info.exportedAt)}` : '',
      ].filter(Boolean).join(' · ') }),
    ]),
    el('div', { class: 'import-options' }, [
      el('div', { class: 'import-option', id: 'import-option-restore' }, [
        el('h3', { text: '그대로 복원하기' }),
        el('p', { class: 'muted', text: '모든 회차의 응답 · 선생님 메모 · 자리표 · 1인 1역 · 상담 기록이 새 교실로 되살아나요. 선생님 링크와 학생 QR 은 새로 만들어지므로 QR 을 다시 나눠 줘야 해요.' }),
        info.backup ? null : el('div', { class: 'alert warn', id: 'import-legacy', text: '이 파일은 예전에 내려받은 형식이라 그대로 복원할 수는 없어요. 원래 교실이 남아 있으면 선생님 페이지에서 JSON 을 다시 내려받아 주세요. 오른쪽 "새 학년 교실로 시작"은 쓸 수 있어요.' }),
        el('div', { class: 'btn-row' }, [restoreBtn]),
      ]),
      el('div', { class: 'import-option', id: 'import-option-carry' }, [
        el('h3', { text: '새 학년 교실로 시작' }),
        el('p', { class: 'muted', text: `응답은 가져오지 않고, 교실 이름 · 꼭 표시해야 하는 친구 수${info.roles.length ? ` · 1인 1역 역할 ${info.roles.length}개` : ''}만 위 "교실 만들기"에 채워요. 학생 명단은 새로 적으면 돼요.` }),
        el('label', { class: 'import-check' }, [withRoster, `같은 학생들로 다시 시작해요 (명단 ${info.students.length}명도 채우기)`]),
        el('div', { class: 'btn-row' }, [
          el('button', { type: 'button', class: 'btn', id: 'import-carry-btn', text: '🌱 교실 만들기 칸에 채우기', onClick: () => carryOver(info, withRoster.checked) }),
        ]),
      ]),
    ]),
  );
  importPreview.classList.remove('hidden');
}

async function pickImportFile() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  showImportError('');
  importPreview.classList.add('hidden');
  importPreview.replaceChildren();
  if (file.size > 12 * 1024 * 1024) return showImportError('파일이 너무 커요. 선생님 페이지에서 내려받은 JSON 파일인지 확인해 주세요.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { return showImportError('JSON 파일을 읽지 못했어요. 선생님 페이지의 "JSON 내보내기"로 받은 파일을 골라 주세요.'); }
  const info = describeExport(data);
  if (!info) return showImportError('이 파일에서 교실 자료를 찾지 못했어요. 선생님 페이지의 "JSON 내보내기"로 받은 파일을 골라 주세요.');
  renderImportPreview(info, file.name);
}
importBtn.addEventListener('click', pickImportFile);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const names = parseNames(studentsInput.value);
  if (names.length < 2) return showError('학생을 2명 이상 입력해 주세요.');
  createBtn.disabled = true;
  try {
    const room = await api('/api/rooms', {
      method: 'POST',
      body: { name: nameInput.value, students: names, minGood: Number(minGoodInput.value), minBad: Number(minBadInput.value), ...(introInput.checked ? { kind: 'intro' } : {}), ...(carriedRoles?.length ? { roles: carriedRoles } : {}) },
    });
    showResult(room, { notes: [introInput.checked ? '🌱 첫 회차를 "새 학기 첫 조사"로 열었어요. 학생은 아는 친구와 예전 사이를 표시해요.' : '', room.roleCount ? `1인 1역 역할 ${room.roleCount}개를 함께 가져왔어요. 선생님 페이지의 "1인 1역"에서 확인할 수 있어요.` : ''] });
    carriedRoles = null;
    renderCarried();
    toast('교실을 만들었어요.');
  } catch (err) {
    showError(err.message);
  } finally {
    createBtn.disabled = false;
  }
});

demoBtn.addEventListener('click', async () => {
  demoBtn.disabled = true;
  try {
    const room = await api('/api/rooms/demo', { method: 'POST' });
    showResult(room);
    toast('예시 교실을 만들었어요. 선생님 페이지에서 확인해 보세요.');
  } catch (err) {
    showError(err.message);
  } finally {
    demoBtn.disabled = false;
  }
});

document.getElementById('copy-admin').addEventListener('click', () => copyText(adminUrlInput.value));

function renderSaved() {
  const list = savedRooms.list();
  const card = document.getElementById('saved-card');
  const ul = document.getElementById('saved-list');
  ul.replaceChildren();
  card.classList.toggle('hidden', list.length === 0);
  for (const r of list) {
    ul.append(el('li', {}, [
      el('a', { href: `/t/${r.adminToken}`, class: 'btn small primary', text: r.name }),
      el('span', { class: 'muted', text: fmtDate(r.createdAt) }),
      el('span', { style: { flex: 1 } }),
      el('button', {
        class: 'btn small', text: '목록에서 지우기',
        onClick: () => { savedRooms.remove(r.adminToken); renderSaved(); },
      }),
    ]));
  }
}
renderSaved();
document.getElementById('hero-mascot').innerHTML = mascotSvg({ size: 96 });

// 서버 저장소 상태 확인 (DB 미연결 등 경고)
api('/api/health').then((h) => {
  if (h?.notice) {
    const box = document.getElementById('storage-notice');
    box.textContent = `⚠️ ${h.notice}`;
    box.classList.remove('hidden');
  }
}).catch(() => {});
