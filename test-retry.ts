/**
 * CI-only safety net for wall-clock flakes: a shared runner can stall a worker
 * long enough to blow a timing budget in a test that is merely slow, not wrong.
 * Locally retries stay off so a flake is visible the moment it is introduced.
 */
export const ciRetry = process.env.CI ? { count: 3, delay: 50 } : 0;
