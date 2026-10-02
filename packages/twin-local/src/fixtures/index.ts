import type { ScenarioFixture } from '../seed.js';
import { INC_001 } from './inc-001.js';
import { INC_009 } from './inc-009.js';
import { INC_011 } from './inc-011.js';
import { INC_014 } from './inc-014.js';
import { INC_020 } from './inc-020.js';
import { INC_021 } from './inc-021.js';

/**
 * Local scenario fixtures.
 *
 * Three of the first four have an innocent deployment. That ratio is deliberate: a system
 * evaluated only on scenarios where the deploy is guilty will learn to blame the
 * newest deploy and score well doing it.
 */
export const FIXTURES: Record<string, ScenarioFixture> = {
  'INC-001': INC_001,
  'INC-009': INC_009,
  'INC-011': INC_011,
  'INC-014': INC_014,
  'INC-020': INC_020,
  'INC-021': INC_021,
};

export function fixture(id: string): ScenarioFixture {
  const found = FIXTURES[id];
  if (!found) {
    throw new Error(`No local fixture for ${id}. Available: ${Object.keys(FIXTURES).join(', ')}`);
  }
  return found;
}

export { INC_001, INC_009, INC_011, INC_014, INC_020, INC_021 };
