import { followupView, createFollowup, updateFollowup, deleteFollowup } from './followups.js';

export function registerFollowupRoutes(app, { requireRoom, mutateRoom }) {
  const base = '/api/teacher/:adminToken/followups';
  const route = (handler) => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.entry ? { entry: error.entry } : {}) });
      next(error);
    }
  };
  app.get(base, route(async (req, res) => res.json(followupView(await requireRoom(req)))));
  app.post(base, route(async (req, res) => {
    const found = await requireRoom(req);
    let entry;
    const room = await mutateRoom(found, (fresh) => { entry = createFollowup(fresh, req.body || {}); });
    res.status(201).json({ ...followupView(room), entry });
  }));
  app.put(`${base}/:id`, route(async (req, res) => {
    const found = await requireRoom(req);
    let entry;
    const room = await mutateRoom(found, (fresh) => { entry = updateFollowup(fresh, req.params.id, req.body || {}); });
    res.json({ ...followupView(room), entry });
  }));
  app.delete(`${base}/:id`, route(async (req, res) => {
    const found = await requireRoom(req);
    const room = await mutateRoom(found, (fresh) => { deleteFollowup(fresh, req.params.id, req.body?.expectedVersion); });
    res.json(followupView(room));
  }));
}
