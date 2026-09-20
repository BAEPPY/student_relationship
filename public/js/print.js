import { api, el, copyText } from './common.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');
let data = null;
let showLinks = false;

function render() {
  app.replaceChildren();
  const info = el('div', { class: 'alert info no-print' }, [
    '카드를 인쇄해서 잘라 학생에게 한 장씩 나눠 주세요. 학생은 QR을 찍어 자기 페이지에 들어가요. ',
    el('b', { text: '다른 학생의 카드를 보지 않도록 개별적으로 전달해 주세요.' }),
    ' QR 대신 링크를 개인 메시지로 보내려면 오른쪽 위 "링크 목록 보기"를 누르세요.',
  ]);
  app.append(info);

  if (showLinks) {
    app.append(el('section', { class: 'card' }, [
      el('h2', { text: `${data.room.name} · 학생 링크 목록` }),
      el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), el('th', { text: '개인 링크' }), el('th')])]),
        el('tbody', {}, data.students.map((s) => el('tr', {}, [
          el('td', { text: s.name, style: { fontWeight: 600 } }),
          el('td', {}, [el('code', { text: s.url, style: { fontSize: '12px', wordBreak: 'break-all' } })]),
          el('td', {}, [el('button', { type: 'button', class: 'btn small', text: '복사', onClick: () => copyText(s.url) })]),
        ]))),
      ])]),
    ]));
    return;
  }

  app.append(el('div', { class: 'cards' }, data.students.map((s) => el('div', { class: 'qr-card' }, [
    el('div', { class: 'room', text: data.room.name }),
    el('div', { class: 'name', text: s.name }),
    el('img', { src: `${base}/qr/${encodeURIComponent(s.id)}.svg?t=${encodeURIComponent(s.token.slice(0, 6))}`, alt: `${s.name} QR 코드` }),
    el('div', { class: 'note', text: '📱 QR을 찍어 내 친구 관계를 표시해요' }),
    el('div', { class: 'note', text: '🔒 이 카드는 나만 사용해요' }),
    el('div', { class: 'url', text: s.url }),
  ]))));
}

document.getElementById('print-btn').addEventListener('click', () => window.print());
document.getElementById('toggle-links').addEventListener('click', (e) => {
  showLinks = !showLinks;
  e.target.textContent = showLinks ? 'QR 카드 보기' : '링크 목록 보기';
  render();
});

(async () => {
  try {
    data = await api(base);
    document.title = `${data.room.name} · 학생 QR 카드`;
    render();
  } catch (err) {
    app.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: '교실을 열 수 없어요' }), el('p', { text: err.message })]));
  }
})();
