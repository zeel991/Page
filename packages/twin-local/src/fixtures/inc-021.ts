import { join } from 'node:path';
import { loadDemoScenario } from '../demo-loader.js';
import type { ScenarioFixture } from '../seed.js';

/**
 * INC-021: a Node service with real dependencies (express, supertest, vitest, from a
 * package-lock). A deploy makes shipping optional for pickup orders, but the total
 * still reads `order.shipping.speed`, so a pickup order throws. Real files under
 * `demo/orders`; the sandbox must install its dependencies before its tests can run.
 */
export const INC_021: ScenarioFixture = loadDemoScenario(join(import.meta.dirname, '..', '..', '..', '..', 'demo', 'orders'));
