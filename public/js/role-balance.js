import { el } from './common.js';

/** 교사 전용 집계. 당시 지원서가 없는 결과에는 성공률/실패 수를 추정해 붙이지 않습니다. */
export function renderRoleBalance(summary, { onSemesterChange, busy = false } = {}) {
  if (!summary) return el('p', { class: 'muted', text: busy ? '학기별 기록을 불러오는 중이에요…' : '학기별 기록을 아직 불러오지 못했어요.' });
  const select = el('select', { id: 'role-balance-semester', class: 'select', disabled: busy ? true : null, 'aria-label': '역할 균형을 볼 학기' }, summary.semesters.map((semester) => el('option', { value: semester.id, selected: semester.id === summary.semester.id ? true : null, text: `${semester.label} (${semester.range})` })));
  select.addEventListener('change', () => onSemesterChange?.(select.value));
  const outcome = (student, field) => student.knownApplicationCount ? `${student[field]}/${student.knownApplicationCount}회` : '자료 없음';
  const heads = ['학생', '확정 배정', '1지망 배정', '희망 중 배정', '당시 지원서 없음', '최근 연속 희망 외', '경험한 역할'];
  return el('div', { class: 'role-balance', 'aria-busy': busy ? 'true' : 'false' }, [
    el('div', { class: 'role-balance-controls no-print' }, [el('label', { for: 'role-balance-semester', text: '학기' }), select]),
    el('p', { class: 'muted', text: `${summary.throughRound.name}까지 · ${summary.recordCount}개 월별 기록. ${summary.notice}` }),
    el('p', { class: 'muted', text: '지망 배정의 분모는 당시 지원서를 확인할 수 있는 배정 횟수예요. 최근 연속 희망 외 횟수는 자료가 없는 배정에서 끊어져요. 초안과 아직 배정받지 않은 학생은 실패로 세지 않아요.' }),
    summary.undatedRecordCount ? el('p', { class: 'alert warn', text: `시기를 확인할 수 없는 기록 ${summary.undatedRecordCount}개는 학기 집계에서 제외했어요. 지난달 현황의 달 이름을 확인해 주세요.` }) : null,
    el('div', { class: 'role-balance-scroll' }, [el('table', { class: 'role-balance-table' }, [
      el('caption', { text: `${summary.semester.label} 학생별 역할 배정 균형` }),
      el('thead', {}, [el('tr', {}, heads.map((text) => el('th', { scope: 'col', text })))]),
      el('tbody', {}, summary.students.map((student) => el('tr', {}, [
        el('th', { scope: 'row', text: student.name }),
        el('td', { text: `${student.assignmentCount}회` }),
        el('td', { text: outcome(student, 'firstChoiceCount') }),
        el('td', { text: outcome(student, 'anyWishCount') }),
        el('td', { text: `${student.unknownDataCount}회` }),
        el('td', { text: student.knownApplicationCount ? `${student.consecutiveNonWishCount}회` : '자료 없음' }),
        el('td', {}, [el('span', { text: `${student.distinctRoleCount}종` }), Object.keys(student.roleCounts).length ? el('div', { class: 'muted role-balance-rolelist', text: Object.entries(student.roleCounts).map(([id, count]) => `${student.roleNames[id] || '삭제된 역할'} ${count}회`).join(' · ') }) : null]),
      ]))),
    ])]),
  ]);
}
