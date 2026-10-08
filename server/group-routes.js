import { GROUP_LIMITS, teacherGroupApartPairs, previewGroups, createGroupActivity, updateGroupActivity, deleteGroupActivity } from './groups.js';

const error = (message, status = 400) => Object.assign(new Error(message), { status });

export function registerGroupRoutes(app, { requireRoom, mutateRoom, requireRound, currentRound }) {
  const root = '/api/teacher/:adminToken/groups';
  app.use(root, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const roundFor = (room, req, write = false) => {
    const id = write ? req.body?.roundId : req.query.round;
    if (write && (typeof id !== 'string' || !id)) throw error('활동의 기준 회차를 선택해 주세요.');
    if (req.body?.roundId && req.query.round && req.body.roundId !== req.query.round) throw error('활동의 기준 회차가 일치하지 않아요.');
    return id ? requireRound(room, String(id)) : currentRound(room);
  };
  app.get(root, async (req, res) => {
    const room = await requireRoom(req);
    const round = roundFor(room, req);
    res.json({ room: { id: room.id, name: room.name }, students: room.students.map(({ id, name }) => ({ id, name })),
      round: { id: round.id, name: round.name }, rounds: room.rounds.map(({ id, name }) => ({ id, name })),
      teacherApartPairs: teacherGroupApartPairs(room), activities: room.groupActivities || [], limits: GROUP_LIMITS });
  });
  app.post(`${root}/preview`, async (req, res) => {
    const room = await requireRoom(req);
    roundFor(room, req, true);
    const excludeId = req.body?.excludeActivityId || null;
    if (excludeId && !(room.groupActivities || []).some(({ id }) => id === excludeId)) throw error('편집 중인 활동이 삭제됐어요. 새 활동으로 편성해 주세요.', 409);
    res.json(previewGroups(room, req.body, { seed: req.body?.seed, excludeId }));
  });
  app.post(root, async (req, res) => {
    const found = await requireRoom(req);
    let activity;
    const room = await mutateRoom(found, (room) => { roundFor(room, req, true); activity = createGroupActivity(room, req.body); });
    res.status(201).json({ activity, activities: room.groupActivities });
  });
  app.put(`${root}/:id`, async (req, res) => {
    const found = await requireRoom(req);
    let activity;
    const room = await mutateRoom(found, (room) => { roundFor(room, req, true); activity = updateGroupActivity(room, req.params.id, req.body); });
    res.json({ activity, activities: room.groupActivities });
  });
  app.delete(`${root}/:id`, async (req, res) => {
    const found = await requireRoom(req);
    const room = await mutateRoom(found, (room) => { deleteGroupActivity(room, req.params.id, req.body?.expectedVersion); });
    res.json({ activities: room.groupActivities });
  });
}
