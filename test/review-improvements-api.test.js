import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';
import { purgeAll } from '../server/retention.js';

const layout = { blocks: [{ cols: 2, rows: 1 }] };
const aiReply = (params) => ({ stop_reason: 'end_turn', content: [{type:'text', text:JSON.stringify(
  params.output_config.format.schema.properties.assignment
    ? { assignment:[{seat:'b0-r0-c0',student:'S1'},{seat:'b0-r0-c1',student:'S2'}], pairs:[{a:'S1',b:'S2',probability:65,reason:'참고할 관계'}], explanations:[], notes:'함께 살펴보세요.' }
    : { summary:'응답을 살펴보세요.',pairs:[{a:'S1',b:'S2',riskLevel:'medium',conflictType:'의견 차이',analysis:'현재 응답을 확인하세요.',advice:'대화해 보세요.'}],students:[] }
)}] });
async function setup(t, store, create = async (params) => aiReply(params)) {
  const app = createApp({store, aiClient:{beta:{messages:{create}}}});
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, method='GET', body, expected=200) {
    const response = await fetch(base+route, {method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const created = await call('/api/rooms','POST',{name:'검증반',students:['검증학생가','검증학생나'],minGood:0,minBad:0},201);
  const teacher = `/api/teacher/${created.adminToken}`;
  const view = await call(teacher);
  return {call,teacher,view,created,store};
}

for (const [kind,makeStore] of [['File',()=>new FileStore(null)],['Postgres',()=>new PgStore(new FakePool()).init()]]) {
  test(`${kind}: 회차별 자리표·보고서·이력 복원과 중복 저장 충돌`, async t => {
    const {call,teacher,view} = await setup(t,await makeStore());
    const [a,b] = view.students;
    const roundA = view.round.id;
    const first = await call(`${teacher}/seating`,'PUT',{roundId:roundA,expectedVersionId:null,layout,seats:{'b0-r0-c0':a.id,'b0-r0-c1':b.id},label:'첫 배정'});
    const firstVersion = first.seating.versionId;
    assert.equal(first.seatingHistory.length,1);
    const second = await call(`${teacher}/seating?round=${roundA}`,'PUT',{roundId:roundA,expectedVersionId:firstVersion,layout,seats:{'b0-r0-c0':b.id,'b0-r0-c1':a.id},label:'둘째 배정'});
    assert.equal(second.seatingHistory.length,2);
    await call(`${teacher}/seating`,'PUT',{roundId:roundA,expectedVersionId:firstVersion,layout,seats:{}},409);
    const next = await call(`${teacher}/rounds`,'POST',{name:'다음 조사'},201);
    const roundB=next.round.id;
    assert.equal(next.seating,null);
    const savedB=await call(`${teacher}/seating`,'PUT',{roundId:roundB,expectedVersionId:null,layout,seats:{'b0-r0-c0':a.id}});
    const restored=await call(`${teacher}/seating`,'PUT',{roundId:roundA,expectedVersionId:second.seating.versionId,sourceHistoryId:firstVersion,label:'첫 배정 복원',layout,seats:first.seating.seats});
    assert.equal(restored.round.id,roundA);
    assert.equal(restored.seatingHistory[0].source,'restore');
    assert.deepEqual(restored.seating.seats,first.seating.seats);
    assert.deepEqual((await call(teacher)).seating,savedB.seating);
    const report=await call(`${teacher}/report.json?round=${roundA}`);
    assert.deepEqual(report.blocks.find(block=>block.type==='seatmap').blocks[0].cells,[[a.name,b.name]]);
    const exported=await call(`${teacher}/export.json`);
    assert.equal(exported.rounds.find(round=>round.id===roundA).seatingHistory.length,3);
    assert.deepEqual(exported.rounds.find(round=>round.id===roundB).seating.seats,savedB.seating.seats);
    await call(`${teacher}/seating?round=${roundA}`,'PUT',{roundId:roundB,layout,seats:{}},400);
    await call(`${teacher}/rounds/${roundA}`,'DELETE');
    assert.equal((await call(`${teacher}/export.json`)).rounds.some(round=>round.id===roundA),false);
  });

  test(`${kind}: 기존 자리표의 첫 조회·저장 버전이 일치하고 다음 회차에 복제되지 않음`, async t => {
    const {call,teacher,view,created,store} = await setup(t,await makeStore());
    await store.updateRoom(created.id,room=>{
      room.seating={layout,seats:{'b0-r0-c0':view.students[0].id},updatedAt:'2026-10-08T00:00:00.000Z'};
      delete room.rounds[0].seating;
      delete room.rounds[0].seatingHistory;
    });
    const first=await call(teacher);
    const second=await call(teacher);
    assert.equal(first.seating.versionId,second.seating.versionId);
    const saved=await call(`${teacher}/seating`,'PUT',{roundId:first.round.id,expectedVersionId:first.seating.versionId,layout,seats:first.seating.seats});
    assert.equal(saved.seatingHistory.length,2);
    const next=await call(`${teacher}/rounds`,'POST',{name:'자리 없는 새 조사'},201);
    assert.equal(next.seating,null);
    assert.equal((await call(`${teacher}?round=${view.round.id}`)).seatingHistory.length,2);
    assert.equal(Object.hasOwn(await store.getRoom(created.id),'seating'),false);
  });
}

test('삭제한 학생·역할은 과거 회차와 모든 자리표 이력에서도 정리됨',async t=>{
  const {call,teacher,view}=await setup(t,new FileStore(null));
  const roleView=await call(`${teacher}/roles/default`,'POST');
  const role=roleView.roles[0];
  const student=view.students[0];
  const saved=await call(`${teacher}/seating`,'PUT',{roundId:view.round.id,layout,seats:{'b0-r0-c0':student.id},pinned:['b0-r0-c0'],roleSeats:{'b0-r0-c1':role.id}});
  await call(`${teacher}/seating`,'PUT',{...saved.seating,roundId:view.round.id,seats:{'b0-r0-c1':student.id},pinned:['b0-r0-c1']});
  await call(`${teacher}/rounds`,'POST',{name:'새 조사'},201);
  await call(`${teacher}/students/${student.id}`,'DELETE');
  await call(`${teacher}/roles`,'PUT',{roles:[]});
  const old=await call(`${teacher}?round=${view.round.id}`);
  for(const plan of [old.seating,...old.seatingHistory.map(entry=>entry.seating)]) {
    assert.equal(Object.values(plan.seats).includes(student.id),false);
    assert.deepEqual(plan.pinned,[]);
    assert.deepEqual(plan.roleSeats,{});
  }
});

test('AI 입력 당시 근거를 기록하고 임시 저장은 최신성을 바꾸지 않지만 제출·메모는 바꿈',async t=>{
  const {call,teacher,view}=await setup(t,new FileStore(null));
  const student=view.students[0];
  const route=`/api/student/${student.token}`;
  const analyzed=await call(`${teacher}/ai/analyze`,'POST',{roundId:view.round.id});
  assert.equal(analyzed.aiAnalysis.context.status,'fresh');
  assert.equal(analyzed.aiAnalysis.context.inputCoverage.submitted,0);
  assert.equal(analyzed.aiAnalysis.context.currentCoverage.total,2);
  const studentView=await call(route);
  assert.equal(Object.hasOwn(studentView,'aiAnalysis'),false);
  assert.equal(Object.hasOwn(studentView,'seatingHistory'),false);
  await call(`${route}/draft`,'PUT',{roundId:view.round.id,revision:0,step:'profile',sections:{profile:{partnerText:'작성 중 내용'}}});
  assert.equal((await call(teacher)).aiAnalysis.context.status,'fresh');
  await call(`${route}/profile`,'PUT',{roundId:view.round.id,traits:[],partnerTraits:[],partnerText:'제출한 내용'});
  assert.equal((await call(teacher)).aiAnalysis.context.status,'stale');
  const updated=await call(`${teacher}/ai/analyze`,'POST',{roundId:view.round.id});
  assert.equal(updated.aiAnalysis.context.status,'fresh');
  assert.ok(updated.aiAnalysis.context.evidence.some(e=>e.kind==='profile' && e.studentIds.includes(student.id)));
  await call(`${teacher}/notes`,'PUT',{notes:{[student.id]:{memo:'새로 관찰한 내용',front:false}},rules:[]});
  assert.equal((await call(teacher)).aiAnalysis.context.status,'stale');
  const doc=await call(`${teacher}/report.json`);
  assert.match(JSON.stringify(doc),/자료가 바뀌|자료.*변경/);
});

test('AI 요청 도중 응답이 바뀌면 오래된 결과를 최신으로 표시하지 않음',async t=>{
  let release;
  let started;
  const awaiting=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const {call,teacher,view}=await setup(t,new FileStore(null),async params=>{started();await gate;return aiReply(params);});
  const pending=call(`${teacher}/ai/analyze`,'POST',{roundId:view.round.id});
  await awaiting;
  await call(`/api/student/${view.students[0].token}/relations`,'PUT',{roundId:view.round.id,relations:{}});
  release();
  const result=await pending;
  assert.equal(result.aiAnalysis.context.status,'stale');
  assert.equal(result.aiAnalysis.context.inputCoverage.submitted,0);
  assert.equal(result.aiAnalysis.context.currentCoverage.submitted,1);
});

test('AI 자리 배정안은 회차별로 남고 현재 응답 변경을 추적함',async t=>{
  const {call,teacher,view}=await setup(t,new FileStore(null));
  const result=await call(`${teacher}/ai/seating`,'POST',{roundId:view.round.id,layout,seats:{}});
  assert.equal(result.aiSeating.context.status,'fresh');
  assert.deepEqual(result.aiSeating.inputConfig.layout,layout);
  const next=await call(`${teacher}/rounds`,'POST',{name:'새 조사'},201);
  assert.equal(next.aiSeating,null);
  const old=await call(`${teacher}?round=${view.round.id}`);
  assert.equal(old.aiSeating.roundId,view.round.id);
  await call(`${teacher}/notes`,'PUT',{notes:{[view.students[0].id]:{memo:'자리 메모',front:true}},rules:[]});
  assert.equal((await call(`${teacher}?round=${view.round.id}`)).aiSeating.context.status,'stale');
  await call(`${teacher}/rounds/${view.round.id}`,'DELETE');
  const json=await call(`${teacher}/export.json`);
  assert.equal(JSON.stringify(json).includes(result.aiSeating.provenance.fingerprint),false);
});

for (const action of ['delete','rename']) for (const kind of ['analyze','seating']) {
  test(`AI ${kind} 진행 중 학생 ${action} 시 이전 명단의 결과 저장을 거부함`,async t=>{
    let release;
    let started;
    const awaiting=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const {call,teacher,view}=await setup(t,new FileStore(null),async params=>{started();await gate;return aiReply(params);});
    const pending=call(`${teacher}/ai/${kind}`,'POST',{roundId:view.round.id,layout,seats:{}},409);
    await awaiting;
    const student=view.students[0];
    if(action==='delete') await call(`${teacher}/students/${student.id}`,'DELETE');
    else await call(`${teacher}/students/${student.id}`,'PATCH',{name:'변경학생이름'});
    release();
    const result=await pending;
    assert.match(result.error,/명단이 바뀌/);
    const after=await call(teacher);
    assert.equal(after.aiAnalysis,null);
    assert.equal(after.aiSeating,null);
  });
}

test('학생 삭제가 AI 근거와 이전 고정 자리의 식별자까지 정리함',async t=>{
  const {call,teacher,view}=await setup(t,new FileStore(null));
  const student=view.students[0];
  await call(`/api/student/${student.token}/profile`,'PUT',{roundId:view.round.id,partnerText:'자료가 있는 학생',traits:[]});
  await call(`${teacher}/ai/analyze`,'POST',{roundId:view.round.id});
  await call(`${teacher}/ai/seating`,'POST',{roundId:view.round.id,layout,seats:{'b0-r0-c0':student.id},pinned:['b0-r0-c0']});
  await call(`${teacher}/students/${student.id}`,'DELETE');
  const after=await call(`${teacher}/export.json`);
  assert.equal(JSON.stringify(after).includes(student.id),false);
  assert.equal(after.rounds[0].aiAnalysis.context.status,'stale');
  assert.equal(after.rounds[0].aiSeating.context.status,'stale');
});

for (const field of ['seating','aiSeating']) test(`예약 정리가 기존 ${field}의 최신 활동과 원래 회차를 보존함`,async t=>{
  const {store,created,view}=await setup(t,new FileStore(null));
  await store.updateRoom(created.id,room=>{
    room.createdAt='2024-01-01T00:00:00.000Z';
    room.rounds[0].startedAt='2024-01-01T00:00:00.000Z';
    room[field]=field==='seating'
      ? {layout,seats:{},updatedAt:'2026-10-01T00:00:00.000Z'}
      : {roundId:view.round.id,createdAt:'2026-10-01T00:00:00.000Z',assignment:{},pairs:[]};
  });
  const result=await purgeAll(store,new Date('2026-10-08T00:00:00.000Z'));
  assert.equal(result.deletedRooms,0);
  assert.equal(result.deletedRounds,0);
  assert.equal((await store.getRoom(created.id)).rounds[0].id,view.round.id);
});
