import { seedExamples } from '../seed';
import { PostgresDashboardStore } from '../store/postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL, e.g. postgres://localhost:5432/bi');
  process.exit(1);
}
const store = await PostgresDashboardStore.connect(url);
try {
  await seedExamples(store, { teamId: process.env.BI_SEED_TEAM ?? 'team-a' });
} finally {
  await store.close();
}
