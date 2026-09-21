import { api, el, toast, copyText, savedRooms, fmtDate } from './common.js';

const form = document.getElementById('create-form');
const nameInput = document.getElementById('room-name');
const studentsInput = document.getElementById('students');
const minInput = document.getElementById('min-relations');
const errorBox = document.getElementById('create-error');
const createBtn = document.getElementById('create-btn');
const demoBtn = document.getElementById('demo-btn');
const resultCard = document.getElementById('result-card');
const adminUrlInput = document.getElementById('admin-url');
const goTeacher = document.getElementById('go-teacher');
const countLabel = document.getElementById('student-count');

function parseNames(text) {
  return text.split(/[\n,、，;]+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

studentsInput.addEventListener('input', () => {
  const n = parseNames(studentsInput.value).length;
  countLabel.textContent = n ? `현재 ${n}명` : '';
});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.toggle('hidden', !msg);
}

function showResult(room) {
  savedRooms.add(room);
  adminUrlInput.value = room.adminUrl;
  goTeacher.href = `/t/${room.adminToken}`;
  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth' });
  renderSaved();

// 서버 저장소 상태 확인 (DB 미연결 등 경고)
api('/api/health').then((h) => {
  if (h?.notice) {
    const box = document.getElementById('storage-notice');
    box.textContent = `⚠️ ${h.notice}`;
    box.classList.remove('hidden');
  }
}).catch(() => {});
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
      body: { name: nameInput.value, students: names, minRelations: Number(minInput.value) || 3 },
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

// 서버 저장소 상태 확인 (DB 미연결 등 경고)
api('/api/health').then((h) => {
  if (h?.notice) {
    const box = document.getElementById('storage-notice');
    box.textContent = `⚠️ ${h.notice}`;
    box.classList.remove('hidden');
  }
}).catch(() => {});
