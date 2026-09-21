// Vercel 같은 서버리스 환경용 진입점입니다. (내 컴퓨터/Docker/Render 에서는 server/index.js 가 실행됩니다)
// Vercel 은 프로젝트 루트의 app.js 가 Express 앱을 기본 내보내기(default export)하면 자동으로 함수로 배포합니다.
import express from 'express'; // eslint-disable-line no-unused-vars -- Vercel 의 Express 자동 감지용
import { openStore } from './server/storage.js';
import { createApp } from './server/app.js';

const { store, kind, notice } = await openStore({ serverless: true });
const app = createApp({ store, storageKind: kind, storageNotice: notice });

export default app;
