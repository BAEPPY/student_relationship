import { api, el, toast, copyText, savedRooms, fmtDate, mascotSvg } from './common.js';

const form = document.getElementById('create-form');
const nameInput = document.getElementById('room-name');
const studentsInput = document.getElementById('students');
const minGoodInput = document.getElementById('min-good');
const minBadInput = document.getElementById('min-bad');
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

function showResult(room) {
  savedRooms.add(room);
  adminUrlInput.value = room.adminUrl;
  goTeacher.href = `/t/${room.adminToken}`;
  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth' });
  renderSaved();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const names = parseNames(studentsInput.value);
  if (names.length < 2) return showError('학생을 2명 이상 입력해 주세요.');
  createBtn.disabled = true;
  try {
    const room = await api('/api/rooms', {
      method: 'POST',
      body: { name: nameInput.value, students: names, minGood: Number(minGoodInput.value), minBad: Number(minBadInput.value) },
    });
    showResult(room);
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
