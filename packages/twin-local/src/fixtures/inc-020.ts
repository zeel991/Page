import { join } from 'node:path';
import { loadDemoScenario } from '../demo-loader.js';
import type { ScenarioFixture } from '../seed.js';

/**
 * INC-020: a Python service. A deploy makes the tax lookup strict (`TAX_RATES[region]`
 * instead of `.get(region, DEFAULT_RATE)`), so an invoice for a region with no rate
 * raises KeyError. The suite passes, because it only exercises regions that have
 * one. Real files under `demo/billing`, runnable with pytest.
 */
export const INC_020: ScenarioFixture = loadDemoScenario(join(import.meta.dirname, '..', '..', '..', '..', 'demo', 'billing'));
