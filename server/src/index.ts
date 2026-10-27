import { createServer } from 'node:http';
import { createApp } from './app.js';
import { lockPlan, tx } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { recalculate } from './services/recalc.js';
import { attachRealtime } from './services/realtime.js';

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  await migrate();
  const app = createApp();
  const server = createServer(app);
  attachRealtime(server);
  server.listen(PORT, () => console.log(`EV production planner listening on http://localhost:${PORT}`));

  // Time moves forward: re-run forward propagation so unstarted/overdue work is re-forecast.
  const tick = async () => {
    try {
      await tx(async (c) => {
        await lockPlan(c);
        const r = await recalculate(c, { userId: null, kind: 'TIME_TICK', summary: 'Scheduled recalculation', quiet: false });
        if (!r.changes.length) await c.query('DELETE FROM plan_versions WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM delay_events WHERE plan_version = $1)', [r.version]);
      });
    } catch (e) {
      console.error('Scheduled recalculation failed', e);
    }
  };
  const minutes = Number(process.env.RECALC_INTERVAL_MINUTES ?? 30);
  if (minutes > 0) setInterval(tick, minutes * 60_000);
  void tick();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
