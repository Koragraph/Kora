// The standing payload — what every API call of a Claude session re-bills whether or not the graph is used: the
// appended system prompt (rulebook) and the CLAUDE.md managed block. Measured 2026-09-22: 1,029 and 2,079 chars
// (≈ 800 tokens together). This test is the ratchet: growth past the bounds below must be a deliberate, measured change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createEnforcer } from './index';

export const SYSTEM_PROMPT_MAX = 1200;
export const CLAUDE_MD_BLOCK_MAX = 2400;

