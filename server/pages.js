// 각 페이지의 HTML 껍데기입니다. 실제 내용은 public/js/*.js 가 그립니다.
// 파일이 아니라 모듈에 두는 이유: 서버리스(Vercel) 번들에 항상 포함되게 하기 위해서입니다.

export const index = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>학생 관계 마인드맵</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body class="kid">
  <header class="kid-header">
    <div class="kid-sky" aria-hidden="true"></div>
    <svg class="kid-wave" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 30 C 240 70 480 0 720 30 C 960 60 1200 10 1440 30 L1440 60 L0 60 Z" fill="#fff8ee"/></svg>
    <div class="kid-title"><a class="kid-room" href="/">학생 관계 마인드맵</a></div>
  </header>

  <main class="container narrow">
    <div id="storage-notice" class="alert error hidden"></div>
    <section class="card">
      <div class="hero-card">
        <div class="hero-mascot" id="hero-mascot"></div>
        <div>
          <h1>우리 반 친구 관계,<br>한눈에 보기</h1>
          <p class="muted">학생들이 각자 친구 관계를 표시하면, 선생님은 전체 관계도를 종합적으로 확인하고 갈등 가능성을 미리 살펴볼 수 있어요.</p>
        </div>
      </div>
      <div class="steps">
        <div class="step"><span class="n">1</span><div><b>교실 만들기</b><br><span class="muted">학생 이름을 등록하면 학생마다 개인 QR 링크가 만들어져요.</span></div></div>
        <div class="step"><span class="n">2</span><div><b>학생이 관계 표시</b><br><span class="muted">각자 자기 QR로 접속해서 좋은 사이(빨간 화살표)와 안 좋은 사이(검은 화살표)를 표시해요. 다른 학생의 답은 볼 수 없어요.</span></div></div>
        <div class="step"><span class="n">3</span><div><b>선생님이 종합 확인</b><br><span class="muted">관계가 많은 학생은 가운데, 적은 학생은 바깥쪽에 배치된 관계도와 갈등 확률 분석을 확인해요.</span></div></div>
      </div>
    </section>

    <section class="card" id="create-card">
      <h2>교실 만들기</h2>
      <form id="create-form">
        <div class="field">
          <label for="room-name">교실 이름</label>
          <input type="text" id="room-name" placeholder="예: 3학년 2반" maxlength="60" required>
        </div>
        <div class="field">
          <label for="students">학생 이름 (한 줄에 한 명)</label>
          <textarea id="students" placeholder="김하늘&#10;이도윤&#10;박서연&#10;..." required></textarea>
          <div class="help">쉼표로 구분해서 적어도 돼요. 같은 이름이 있으면 구분할 수 있게 적어 주세요 (예: 김민준A, 김민준B). <span id="student-count"></span></div>
          <div class="btn-row" style="margin-top:8px">
            <button type="button" class="btn small" id="roster-file-btn">📄 명단 파일 올리기</button>
            <span class="muted">한글(.hwp, .hwpx) · 워드(.docx) · 텍스트(.txt) — 번호·이름 표나 한 줄에 한 명씩 적힌 파일에서 이름을 읽어 와요. 파일은 저장하지 않아요.</span>
          </div>
          <div id="roster-notice" class="alert warn hidden" style="margin-top:8px;margin-bottom:0"></div>
        </div>
        <div class="field">
          <label>학생 한 명이 꼭 표시해야 하는 친구 수</label>
          <div class="btn-row">
            <label style="font-weight:600">❤️ 좋은 사이 <input type="number" id="min-good" value="3" min="0" max="10" style="width:80px;margin-left:6px"> 명 이상</label>
            <label style="font-weight:600">⚡ 안 좋은 사이 <input type="number" id="min-bad" value="1" min="0" max="10" style="width:80px;margin-left:6px"> 명 이상</label>
          </div>
          <div class="help">둘 다 채워야 제출할 수 있어요. 반 인원이 적으면 자동으로 줄어들어요.</div>
        </div>
        <div id="create-error" class="alert error hidden"></div>
        <div class="btn-row">
          <button type="submit" class="btn primary" id="create-btn">교실 만들기</button>
          <button type="button" class="btn" id="demo-btn">예시 데이터로 체험하기</button>
        </div>
      </form>
    </section>

    <section class="card hidden" id="result-card">
      <h2>교실이 만들어졌어요 🎉</h2>
      <div class="alert warn">아래 <b>선생님 관리 링크</b>는 교실에 들어가는 유일한 열쇠예요. 즐겨찾기에 저장하거나 안전한 곳에 복사해 두세요. 학생에게는 절대 알려주지 마세요.</div>
      <div class="link-box">
        <input type="text" id="admin-url" readonly>
        <button type="button" class="btn" id="copy-admin">복사</button>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <a class="btn primary" id="go-teacher" href="#">선생님 페이지로 가기</a>
      </div>
    </section>

    <section class="card hidden" id="saved-card">
      <h2>이 브라우저에서 만든 교실</h2>
      <ul class="room-list" id="saved-list" style="list-style:none;padding:0;margin:0"></ul>
      <p class="muted" style="margin-top:8px">이 목록은 지금 사용 중인 브라우저에만 저장돼요.</p>
    </section>

    <section class="card">
      <h2>개인정보와 안전</h2>
      <ul class="muted" style="padding-left:18px">
        <li>학생은 자기 QR 링크로만 접속하며, 자기가 표시한 관계만 볼 수 있어요.</li>
        <li>학생 링크와 선생님 링크는 추측할 수 없는 긴 임의 문자열이에요. 링크가 유출되면 선생님 페이지에서 새 링크를 발급할 수 있어요.</li>
        <li>갈등 확률은 학생 응답을 바탕으로 한 <b>참고용 추정치</b>예요. 학생을 판단하는 근거가 아니라 관심을 기울일 곳을 찾는 도구로 사용해 주세요.</li>
        <li>조사 응답은 마감 뒤 <b>14개월이 지나면 자동으로 삭제</b>돼요. 오래 보관하려면 선생님 페이지에서 CSV/JSON으로 내보내 두세요. 삭제 60일 전부터 선생님 페이지에 미리 알려 드려요.</li>
      </ul>
    </section>
  </main>
  <script type="module" src="/js/index.js"></script>
</body>
</html>
`;

export const teacher = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>선생님 페이지 · 학생 관계 마인드맵</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body class="teacher">
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="logo"></span>학생 관계 마인드맵</a>
      <span class="badge blue">선생님 페이지</span>
      <span class="spacer"></span>
      <span class="muted" id="last-updated"></span>
    </div>
  </header>
  <main class="container" id="app">
    <div class="card" id="loading">불러오는 중…</div>
  </main>
  <script type="module" src="/js/teacher.js"></script>
</body>
</html>
`;

export const student = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#a9ddf6">
  <title>내 친구 관계 지도</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/student-steps.css">
</head>
<body class="kid">
  <header class="kid-header">
    <div class="kid-sky" aria-hidden="true"></div>
    <svg class="kid-wave" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 30 C 240 70 480 0 720 30 C 960 60 1200 10 1440 30 L1440 60 L0 60 Z" fill="#fff8ee"/></svg>
    <div class="kid-title">
      <span class="kid-room" id="room-name">친구 관계 지도</span>
    </div>
  </header>

  <main class="container narrow" id="app">
    <div class="card" id="loading">불러오는 중…</div>
  </main>

  <script type="module" src="/js/student.js"></script>
</body>
</html>
`;

export const print = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>학생 QR 카드</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <header class="topbar no-print">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="logo"></span>학생 관계 마인드맵</a>
      <span class="spacer"></span>
      <button type="button" class="btn" id="toggle-links">링크 목록 보기</button>
      <button type="button" class="btn primary" id="print-btn">인쇄하기</button>
    </div>
  </header>
  <main class="container" id="app">
    <div class="card" id="loading">불러오는 중…</div>
  </main>
  <script type="module" src="/js/print.js"></script>
</body>
</html>
`;

export const notFound = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>페이지를 찾을 수 없어요</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <main class="container narrow">
    <section class="card" style="text-align:center;margin-top:40px">
      <h1>페이지를 찾을 수 없어요</h1>
      <p class="muted">주소가 정확한지 확인해 주세요.</p>
      <a class="btn primary" href="/">처음으로</a>
    </section>
  </main>
</body>
</html>
`;

export const seats = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>자리 배정 · 학생 관계 마인드맵</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <header class="topbar no-print">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="logo"></span>학생 관계 마인드맵</a>
      <span class="badge blue">자리 배정</span>
      <span class="spacer"></span>
      <a class="btn small" id="back-link" href="#">선생님 페이지로</a>
    </div>
  </header>
  <main class="container" id="app">
    <div class="card" id="loading">불러오는 중…</div>
  </main>
  <script type="module" src="/js/seats.js"></script>
</body>
</html>
`;

export const roles = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>1인 1역 · 학생 관계 마인드맵</title>
  <link rel="preload" href="/fonts/GangwonEduAll-Bold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/roles.css">
</head>
<body>
  <header class="topbar no-print">
    <div class="topbar-inner">
      <a class="brand" href="/"><span class="logo"></span>학생 관계 마인드맵</a>
      <span class="badge blue">1인 1역</span>
      <span class="spacer"></span>
      <a class="btn small" id="back-link" href="#">선생님 페이지로</a>
    </div>
  </header>
  <main class="container" id="app">
    <div class="card" id="loading">불러오는 중…</div>
  </main>
  <script type="module" src="/js/roles.js"></script>
</body>
</html>
`;
