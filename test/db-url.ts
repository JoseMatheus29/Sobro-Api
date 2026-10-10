// Postgres de teste do docker-compose (npm run test:db). Troque com TEST_DATABASE_URL.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://sobro:sobro@localhost:5433/sobro_test';
