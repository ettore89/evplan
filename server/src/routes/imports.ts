/** Controlled imports: upload a workbook, review the preview and name decisions, then apply. */
import { Router, type Request } from 'express';
import { lockPlan, pool, tx } from '../db/pool.js';
import { HttpError } from '../services/common.js';
import { applyBatch, discardBatch, getBatch, listBatches, previewUpload, updateDecisions } from '../services/importTracker.js';

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id');
  return n;
};

export function importRouter() {
  const r = Router();
  r.get('/', async (_req, res) => res.json(await listBatches(pool)));
  // Raw workbook body (parsed with express.raw in app.ts); the original file name travels in a header.
  r.post('/om-tracker', async (req: any, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the .xlsx file as the request body');
    const filename = typeof req.headers['x-filename'] === 'string' ? decodeURIComponent(req.headers['x-filename']) : null;
    const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
    res.status(201).json(await tx((c) => previewUpload(c, req.user, body, filename, { asOf })));
  });
  r.get('/:id', async (req, res) => res.json(await getBatch(pool, id(req))));
  r.put('/:id/decisions', async (req: any, res) => res.json(await tx((c) => updateDecisions(c, req.user, id(req), req.body ?? {}))));
  r.post('/:id/discard', async (req: any, res) => res.json(await tx((c) => discardBatch(c, req.user, id(req)))));
  r.post('/:id/apply', async (req: any, res) => {
    res.json(await tx(async (c) => { await lockPlan(c); return applyBatch(c, req.user, id(req), { allowOlder: !!req.body?.allowOlder, reason: req.body?.reason }); }));
  });
  return r;
}
