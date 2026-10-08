import { newId } from './tokens.js';
import { ensureSeatingHistory } from './seating-history.js';

/** 한국 시간 기준 "2026년 10월" 형태의 회차 이름 */
export function monthName(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월`;
}

export function makeRound(name, now = new Date().toISOString()) {
  return { id: newId(), name, startedAt: now, closedAt: null, relations: {}, submissions: {} };
}

/**
 * 예전 구조(room.relations / room.submissions / room.locked)를 회차 구조로 바꿉니다.
 * 몇 번을 불러도 결과가 같습니다.
 */
export function ensureRounds(room, now = new Date().toISOString()) {
  if (!Array.isArray(room.rounds) || room.rounds.length === 0) {
    const started = room.createdAt || now;
    room.rounds = [{
      id: newId(),
      name: monthName(started),
      startedAt: started,
      closedAt: room.locked ? now : null,
      relations: room.relations || {},
      submissions: room.submissions || {},
    }];
  }
  delete room.relations;
  delete room.submissions;
  delete room.locked;
  for (const r of room.rounds) {
    r.relations ||= {};
    r.submissions ||= {};
    if (r.closedAt === undefined) r.closedAt = null;
  }
  if (!room.rounds.some((r) => r.id === room.currentRoundId)) room.currentRoundId = room.rounds[room.rounds.length - 1].id;
  ensureSeatingHistory(room);
  if (room.aiSeating) {
    const sourceRound = room.rounds.find((r) => r.id === room.aiSeating.roundId);
    if (sourceRound && !sourceRound.aiSeating) sourceRound.aiSeating = structuredClone(room.aiSeating);
    delete room.aiSeating;
  }
  return room;
}

/** 지금 학생이 답하는 회차 (가장 최근 회차) */
export function currentRound(room) {
  return room.rounds.find((r) => r.id === room.currentRoundId) || room.rounds[room.rounds.length - 1];
}

export function findRound(room, id) {
  return room.rounds.find((r) => r.id === id) || null;
}

/** 회차 + 학생 명단을 분석 함수에 넣을 수 있는 모양으로 */
export function roundRoom(room, round) {
  return { students: room.students, relations: round.relations, submissions: round.submissions };
}

export function roundView(round) {
  return { id: round.id, name: round.name, startedAt: round.startedAt, closedAt: round.closedAt, open: !round.closedAt };
}
