# 학생 관계 마인드맵

학생들이 각자 친구 관계를 마인드맵처럼 표시하면, 교사가 학급 전체의 관계를 종합적으로 확인하고 갈등 가능성을 미리 살펴볼 수 있는 웹 앱입니다.

## 주요 기능

**교사**
- 교실을 만들고 학생 이름을 등록하면 학생마다 개인 QR 링크가 만들어집니다.
- QR 카드 인쇄 페이지에서 카드를 출력해 학생에게 한 장씩 나눠 줄 수 있습니다. (링크 목록으로 개별 전송도 가능)
- 전체 관계도: 관계(화살표)가 많은 학생은 가운데, 적은 학생은 바깥쪽에 배치됩니다.
  - 빨간 화살표 = 좋은 사이, 검은 화살표 = 안 좋은 사이
  - 화살표를 누르면 그 학생이 적은 이유를 볼 수 있습니다.
  - 학생을 누르면 그 학생의 관계만 강조되고, 받은/준 관계와 이유가 정리되어 보입니다.
  - 필터(좋은 사이만 / 안 좋은 사이만), 확대·축소, 상자 끌어서 옮기기
- 갈등 가능성 분석: 학생 쌍마다 앞으로 갈등이 생길 추정 확률(%)과 그 근거를 보여 줍니다.
- 자리 배정: 교실 배치(예: `2x4, 2x5, 2x4`)를 입력하면 안 좋은 사이를 떨어뜨리고 고립 위험 학생을 배려하는 자리표를 자동으로 만듭니다. 자리 바꾸기, 고정(📌), 친한 친구 가까이/떨어뜨리기 옵션, 저장, 인쇄를 지원합니다.
- 교사 메모·지정 규칙: 학생별 메모와 "앞자리 필요(👓, 시력 등)" 표시, 두 학생 사이의 "떨어뜨리기"/"가까이 앉히기" 규칙을 미리 적어 두면 자동 배정에 반영되고 좌석표와 학생 상세에서 참고할 수 있습니다. 학생에게는 보이지 않습니다.
- 제출 현황, 제출 마감/해제, 학생 추가·이름 변경·삭제, 응답 초기화, 링크 재발급, CSV/JSON 내보내기, 교실 삭제

**학생**
- 자기 QR 링크로 접속하면 "나"를 가운데에 둔 관계 지도와 반 친구 목록이 보입니다.
- 친구마다 **좋은 사이**(이유 선택) 또는 **안 좋은 사이**(이유 필수)를 표시합니다. 이유는 객관적인 선택지 중에서 고르거나 직접 적을 수 있습니다.
- 최소 인원(기본 3명) 이상 표시해야 제출할 수 있고, 마감 전까지는 수정할 수 있습니다.
- 학생은 자기가 표시한 내용만 볼 수 있고, 다른 학생의 답은 볼 수 없습니다.

## 연결이 안 되나요? (먼저 읽어 주세요)

이 저장소에는 **코드만** 들어 있습니다. 사이트가 열리려면 이 코드를 실행하는 **서버가 어딘가에서 켜져 있어야** 합니다.

- GitHub 페이지(github.com 주소)나 GitHub Pages 로는 열리지 않습니다. 이 앱은 Node.js 서버가 필요합니다.
- `http://localhost:3000` 은 서버를 켠 **그 컴퓨터에서만** 열립니다. 학생 스마트폰에서는 열리지 않습니다.
- 학생들이 각자 스마트폰으로 접속하려면 아래처럼 **인터넷에 배포**해야 합니다. 10분이면 됩니다.

## 🚀 무료로 배포하기

두 가지 방법이 있습니다. 둘 다 카드 등록 없이 무료로 쓸 수 있고, GitHub 계정으로 가입합니다.

| | 방법 A. Vercel (추천) | 방법 B. Render |
| --- | --- | --- |
| 사이트가 잠드나요? | 아니요. 학생이 접속하면 바로 열립니다. | 15분 동안 접속이 없으면 잠들고, 깨는 데 30초~1분 걸립니다. |
| 데이터베이스 | Vercel 안에서 Neon 무료 DB를 클릭 몇 번으로 만듭니다. 별도 가입 없음. | Neon 에 따로 가입해 연결 문자열을 붙여넣습니다. |
| 관리 화면 | 가볍고 빠릅니다. | 조금 무겁습니다. |
| 비용 | 무료 (Hobby 플랜, 카드 불필요). 개인·비상업용에 한함 | 무료 (카드 불필요) |

### 방법 A. Vercel + Neon (추천)

1. https://vercel.com 에서 **Continue with GitHub** 로 가입합니다. (Hobby 플랜, 무료)
2. 대시보드에서 **Add New… → Project** 를 누르고, 저장소 목록에서 `student_relationship` 옆의 **Import** 를 누릅니다. 처음이면 GitHub 에 Vercel 앱 설치를 허용하는 화면이 먼저 나옵니다.
3. 설정은 그대로 두고 **Deploy** 를 누릅니다. 1~2분 뒤 배포가 끝나면 **Continue to Dashboard** 를 누릅니다.
4. 프로젝트 화면 위쪽의 **Storage** 탭 → **Create Database** → **Neon** 을 고릅니다. 약관에 동의하고, Region 은 **Singapore** (가장 가까움), Plan 은 **Free** 를 고른 뒤 이름을 정하고 **Create** 를 누릅니다. Neon 계정은 이 과정에서 자동으로 만들어집니다.
5. **Connect Project** 에서 이 프로젝트를 고르고 환경(Production, Preview, Development)을 모두 체크한 뒤 연결합니다.
6. **Deployments** 탭에서 가장 위의 배포 오른쪽 **⋯** 메뉴 → **Redeploy** 를 누릅니다. (DB 연결 정보를 반영하기 위해 한 번 다시 배포합니다.)
7. 프로젝트 화면의 `https://student-relationship-….vercel.app` 주소가 사이트 주소입니다. 첫 화면 위에 빨간 경고가 보이지 않으면 DB 연결까지 끝난 것입니다.

버튼 한 번으로 하고 싶다면 아래 버튼을 눌러도 됩니다. 이 버튼은 저장소 **복사본**(`student-relationship-site`)을 내 GitHub 에 만들고 Neon DB 생성까지 한 흐름으로 진행합니다. 다만 이후 원본 저장소를 고쳐도 복사본에는 반영되지 않으니, 코드를 계속 고칠 계획이면 위의 Import 방법을 쓰세요.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FBAEPPY%2Fstudent_relationship&project-name=student-relationship&repository-name=student-relationship-site&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

결제 수단을 등록하라는 화면이 나오면 (Neon 을 Vercel 안에서 만들 때 드물게 요구할 수 있음)

등록하지 말고 Neon 에 직접 가입해서 연결하면 됩니다. Neon 무료 플랜은 카드가 필요 없습니다.

1. https://neon.tech 에서 가입하고 **New project** 를 만듭니다. Region 은 **Asia Pacific (Singapore)** 를 고릅니다.
2. 프로젝트 화면의 **Connect** 버튼을 눌러 `postgresql://` 로 시작하는 연결 문자열을 복사합니다.
3. Vercel 프로젝트 화면에서 **Settings → Environment Variables** 로 가서 Key 에 `DATABASE_URL`, Value 에 복사한 문자열을 넣고, 환경(Production, Preview, Development)을 모두 체크한 뒤 **Save** 를 누릅니다.
4. **Deployments** 탭에서 맨 위 배포의 **⋯** 메뉴 → **Redeploy** 를 누릅니다.

알아 둘 점
- 코드를 GitHub 에 올리면 Vercel 이 자동으로 다시 배포합니다.
- 함수 실행 위치는 `vercel.json` 에서 싱가포르(`sin1`)로 두었습니다. Neon 도 싱가포르를 고르면 가장 빠릅니다.
- 배포 후 첫 화면이나 선생님 페이지에 "데이터베이스가 연결되지 않아…" 경고가 보이면 4~6단계를 다시 확인하세요.

### 방법 B. Render + Neon

Render 는 서버를 통째로 켜 두는 방식이라 코드 변경 없이 동작하지만, 무료 서버는 15분 동안 접속이 없으면 잠듭니다.

1. https://neon.tech 에서 가입하고 **New project** 를 만듭니다. Region 은 **Asia Pacific (Singapore)** 를 고릅니다.
2. 프로젝트 화면의 **Connect** 버튼을 눌러 `postgresql://` 로 시작하는 연결 문자열을 복사합니다.
3. 아래 버튼을 누르고 Render 에 가입합니다. Blueprint 이름을 입력하고, `DATABASE_URL` 칸에 연결 문자열을 붙여넣은 뒤 **Apply** 를 누릅니다.

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BAEPPY/student_relationship)

4. 3~5분 뒤 Render 대시보드에서 `student-relationship` 서비스를 열면 `https://student-relationship-xxxx.onrender.com` 같은 주소가 보입니다.
5. 수업 전에 선생님 페이지를 한 번 미리 열어 서버를 깨워 두세요.

### 그 밖의 방법

- **Railway, Fly.io, Koyeb 등 서버형 호스팅**: 저장소를 연결하고 시작 명령을 `npm start` 로 두면 됩니다. 볼륨(영구 디스크)이 있으면 `DATA_DIR` 을 그 경로로 지정해 파일 저장을 써도 되고, 아니면 `DATABASE_URL` 을 설정하세요.
- **Docker**: 아래 "Docker" 항목을 참고하세요.

## 내 컴퓨터에서 실행하기

Node.js 20 이상이 필요합니다.

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 을 열고 교실을 만드세요.
"예시 데이터로 체험하기" 버튼을 누르면 임의의 응답이 채워진 예시 교실을 바로 볼 수 있습니다.

서버를 켜면 터미널에 `같은 Wi-Fi 기기에서: http://192.168.x.x:3000` 같은 주소가 함께 표시됩니다. 같은 Wi-Fi 에 있는 스마트폰·태블릿은 이 주소로 접속할 수 있습니다. (학교 Wi-Fi 는 기기 간 접속을 막아 두는 경우가 많고, 컴퓨터 방화벽이 막을 수도 있습니다. 이때는 위의 무료 배포 방법을 쓰세요.)

## 설정 (환경 변수)

| 환경 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `PORT` | 서버 포트 | `3000` |
| `DATABASE_URL` | PostgreSQL 연결 문자열. 설정하면 데이터를 DB 에 저장합니다. (Neon, Supabase, Render Postgres 등) | 없음 (파일 저장) |
| `DATA_DIR` | `DATABASE_URL` 이 없을 때 데이터 파일(`rooms.json`)을 저장할 폴더 | `./data` |
| `BASE_URL` | QR 코드·링크에 사용할 공개 주소 (예: `https://example.com`). 비워 두면 접속한 주소를 그대로 사용합니다. | 없음 |
| `DATABASE_SSL` | `false` 로 두면 DB 연결에 SSL 을 쓰지 않습니다. 기본은 외부 주소면 SSL 사용, `localhost` 나 내부 호스트명이면 미사용 | 자동 |
| `DATABASE_SSL_VERIFY` | `false` 로 두면 DB 인증서 검증을 건너뜁니다. (자체 서명 인증서를 쓰는 곳에서만) | `true` |

### Docker

```bash
docker build -t student-relationship .
docker run -p 3000:3000 -v $(pwd)/data:/data student-relationship
# 또는 DB 사용
docker run -p 3000:3000 -e DATABASE_URL=postgresql://... student-relationship
```

## 갈등 확률 계산 방식

학생 응답만으로 계산하는 규칙 기반 추정치이며, 근거를 함께 보여 줍니다.

1. 시작값: 서로 안 좋은 사이 78% · 한쪽만 안 좋은 사이 48% · 한쪽은 좋고 한쪽은 안 좋음 40% · 한쪽만 좋은 사이 8% · 서로 좋은 사이 4%
2. 안 좋은 이유의 심각도: 때리거나 괴롭힘 +15, 무시하거나 따돌림 +12, 놀림·험담 +10, 싸운 적 있음 +10, 말을 함부로 함 +6 등 (최대 +25)
3. 공통 친구 수: 같은 무리에서 자주 마주치므로 +4/명 (최대 +12)
4. 3명 이상에게 안 좋은 사이로 지목된 학생이 포함되면 +6, 좋은 사이로 지목한 학생이 아무도 없는(고립 위험) 학생이 포함되면 +5
5. 결과는 2~97% 사이로 제한하고, 70% 이상은 "높음", 40% 이상은 "주의"로 표시

관계 정보가 전혀 없는 쌍은 계산하지 않습니다. 이 수치는 학생을 판단하는 근거가 아니라 먼저 관심을 기울일 관계를 찾기 위한 참고용입니다. 규칙은 `server/analysis.js`에서 조정할 수 있고, 이유 선택지와 가중치는 `server/reasons.js`에 있습니다.

## 개인정보와 안전

- 학생 링크와 선생님 링크는 추측할 수 없는 임의 문자열입니다. 선생님 링크는 교실에 들어가는 유일한 열쇠이므로 안전하게 보관하세요.
- 학생 API는 본인의 응답과 반 친구 이름만 돌려주며, 다른 학생의 응답이나 링크는 노출하지 않습니다.
- 링크가 유출되면 선생님 페이지에서 해당 학생의 링크를 재발급할 수 있습니다.
- 서버는 로그인 없이 링크만으로 동작하므로, HTTPS가 적용된 곳에 배포하는 것을 권장합니다.

## 프로젝트 구조

```
app.js          Vercel(서버리스)용 진입점
server/
  index.js      일반 서버 시작 (포트, 저장소 선택)
  app.js        Express 앱과 API
  pages.js      각 페이지의 HTML 껍데기
  storage.js    환경에 맞는 저장소 선택
  store.js      JSON 파일 저장소
  pgstore.js    PostgreSQL 저장소 (DATABASE_URL)
  analysis.js   관계 통계와 갈등 가능성 분석
  reasons.js    이유 선택지 목록과 가중치
public/
  js/index.js    교실 만들기
  js/teacher.js  선생님 대시보드
  js/graph.js    관계도 (SVG)
  js/print.js    학생 QR 카드 인쇄
  js/seats.js    자리 배정
  js/student.js  학생 페이지
  css/style.css
vercel.json     Vercel 설정 (함수 리전)
render.yaml     Render 원클릭 배포 설정
Dockerfile      컨테이너 배포용
test/           node:test 기반 테스트
```

## 테스트

```bash
npm test
```
