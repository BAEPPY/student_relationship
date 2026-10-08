// 공통 유틸리티 (모든 페이지에서 사용)

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 신뢰할 수 있는 정적 문자열에만 사용
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.setAttribute('class', v);
    else node.setAttribute(k, v);
  }
  return node;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
export function toast(message, ms = 2200) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했어요.');
  } catch {
    window.prompt('아래 내용을 복사하세요.', text);
  }
}

/** 글(text/plain)과 HTML 을 함께 복사합니다. 붙여 넣는 곳에 따라 서식이 있는 쪽을 씁니다. */
export async function copyRich({ text, html, message = '복사했어요.' }) {
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      toast(message, 3500);
      return;
    }
  } catch { /* 아래 방법으로 */ }
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 3500);
  } catch {
    window.prompt('아래 내용을 복사하세요.', text);
  }
}

/** 선생님 페이지들(관계도 · 자리 배정 · 1인 1역 · QR 인쇄 · 종합 보고서) 사이를 오가는 위쪽 메뉴의 주소를 채웁니다. */
export function setupPageNav(adminToken, roundId = null) {
  const t = encodeURIComponent(adminToken);
  const q = roundId ? `?round=${encodeURIComponent(roundId)}` : '';
  const urls = { dashboard: `/t/${t}`, seats: `/t/${t}/seats${q}`, roles: `/t/${t}/roles${q}`, groups: `/t/${t}/groups${q}`, followups: `/t/${t}/followups`, print: `/t/${t}/print`, report: `/t/${t}/report${q}` };
  for (const a of document.querySelectorAll('.page-nav a[data-nav]')) {
    const url = urls[a.dataset.nav];
    if (url) a.href = url;
  }
}

// ---------- 설명 팝업 ("?" 버튼) ----------
// 버튼 바로 뒤에 말풍선(.help-pop)을 형제로 붙여요. 카드를 다시 그리면 버튼과 함께 사라지고,
// 위치는 화면 기준(position: fixed)으로 잡아 overflow 가 있는 상자 안에서도 잘리지 않아요.
let helpOpen = null;      // 지금 열린 말풍선 { btn, pop }
let helpSeq = 0;
let helpListening = false;

function placeHelpPop(btn, pop) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = r.left;                                   // 기본: 버튼 왼쪽에 맞춰 아래로
  if (left + pw > vw - 8) left = r.right - pw;         // 오른쪽 끝에 가까우면 왼쪽으로 펼침
  left = Math.max(8, Math.min(left, vw - pw - 8));
  let top = r.bottom + 8;
  let above = false;
  if (top + ph > vh - 8 && r.top - ph - 8 >= 8) { top = r.top - ph - 8; above = true; }   // 아래 자리가 없으면 위로
  top = Math.max(8, top);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.classList.toggle('above', above);
  pop.style.setProperty('--arrow-x', `${Math.max(10, Math.min(pw - 20, r.left + r.width / 2 - left - 5))}px`);
}

function onHelpMove() {
  if (!helpOpen) return;
  if (!helpOpen.btn.isConnected) return closeHelp();
  placeHelpPop(helpOpen.btn, helpOpen.pop);
}

function closeHelp({ focus = false } = {}) {
  if (!helpOpen) return;
  const { btn, pop } = helpOpen;
  helpOpen = null;
  pop.remove();
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  window.removeEventListener('scroll', onHelpMove, true);
  window.removeEventListener('resize', onHelpMove);
  if (focus && btn.isConnected) btn.focus();
}

function openHelp(btn, pop) {
  closeHelp();                                          // 한 번에 하나만
  btn.after(pop);
  helpOpen = { btn, pop };
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  placeHelpPop(btn, pop);
  window.addEventListener('scroll', onHelpMove, true);
  window.addEventListener('resize', onHelpMove);
  if (!helpListening) {
    helpListening = true;
    document.addEventListener('click', (e) => {
      if (helpOpen && !helpOpen.pop.contains(e.target) && !helpOpen.btn.contains(e.target)) closeHelp();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && helpOpen) { e.preventDefault(); closeHelp({ focus: true }); } });
  }
}

/**
 * 작은 둥근 "?" 버튼을 돌려줍니다. 누르면 옆에 설명 말풍선이 열려요.
 * text 는 한 문단(문자열)이나 여러 문단(배열). 바깥 클릭 · Esc · 버튼 다시 누르기로 닫히고, 인쇄에는 안 나와요.
 */
export function helpTip(text, { title } = {}) {
  const id = `help-pop-${++helpSeq}`;
  const lines = [].concat(text).filter((t) => t !== null && t !== undefined && t !== '');
  const btn = el('button', { type: 'button', class: 'help-btn', 'aria-label': '설명', 'aria-expanded': 'false', 'aria-controls': id, text: '?' });
  btn.addEventListener('click', () => {
    if (helpOpen && helpOpen.btn === btn) return closeHelp();
    const pop = el('div', { class: 'help-pop', id, role: 'tooltip' }, [
      title ? el('div', { class: 'help-title', text: title }) : null,
      ...lines.map((t) => el('p', { text: t })),
    ]);
    openHelp(btn, pop);
  });
  return btn;
}

export const TYPE_LABEL = { good: '좋은 사이', bad: '안 좋은 사이' };
export const TYPE_ICON = { good: '❤️', bad: '⚡' };

// 간단한 로컬 저장소 (교사가 만든 교실 링크 기억용)
export const savedRooms = {
  key: 'relmap.rooms',
  list() {
    try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch { return []; }
  },
  add(room) {
    const list = this.list().filter((r) => r.adminToken !== room.adminToken);
    list.unshift({ name: room.name, adminToken: room.adminToken, createdAt: room.createdAt || new Date().toISOString() });
    try { localStorage.setItem(this.key, JSON.stringify(list.slice(0, 30))); } catch { /* ignore */ }
  },
  remove(adminToken) {
    try { localStorage.setItem(this.key, JSON.stringify(this.list().filter((r) => r.adminToken !== adminToken))); } catch { /* ignore */ }
  },
};

// null/undefined/false 자식을 걸러내고 자식을 통째로 교체합니다.
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

// ---------- 어린이용 테마 요소 ----------
export const AVATAR_COLORS = ['#ffb3b3', '#ffd59e', '#fff3a3', '#c6f0b2', '#b5e8f7', '#c9c4ff', '#f7c6ec', '#ffcfa8'];
export function avatarColor(i) { return AVATAR_COLORS[Math.abs(i) % AVATAR_COLORS.length]; }

/** 둥근 마스코트 (정적 SVG 문자열). 음영·하이라이트로 입체감을 줍니다. */
export function mascotSvg({ size = 96, color = '#ff7b7b', shade = '#ef5b6b', label = '' } = {}) {
  const uid = `m${Math.random().toString(36).slice(2, 8)}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <radialGradient id="${uid}" cx="38%" cy="32%" r="72%"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${shade}"/></radialGradient>
    </defs>
    <ellipse cx="50" cy="91" rx="24" ry="4.5" fill="#4a3b2f" opacity=".10"/>
    <circle cx="50" cy="50" r="40" fill="url(#${uid})"/>
    <ellipse cx="37" cy="33" rx="13" ry="8" fill="#fff" opacity=".28" transform="rotate(-20 37 33)"/>
    <ellipse cx="40" cy="50" rx="4.2" ry="5.6" fill="#2d2f3a"/><ellipse cx="60" cy="50" rx="4.2" ry="5.6" fill="#2d2f3a"/>
    <circle cx="41.6" cy="47.8" r="1.5" fill="#fff"/><circle cx="61.6" cy="47.8" r="1.5" fill="#fff"/>
    <circle cx="30" cy="60" r="5.5" fill="#ffd2d2" opacity=".6"/><circle cx="70" cy="60" r="5.5" fill="#ffd2d2" opacity=".6"/>
    <path d="M43 63 Q50 70 57 63" fill="none" stroke="#2d2f3a" stroke-width="3" stroke-linecap="round"/>
    ${label ? `<text x="50" y="98" text-anchor="middle" font-size="13" font-weight="800" fill="#4a3b2f">${label}</text>` : ''}
  </svg>`;
}
