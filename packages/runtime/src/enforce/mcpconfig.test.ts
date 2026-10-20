import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpEnabledFor } from './mcpconfig';

test('mcpEnabledFor: off for claude by default (hooks+rulebook+CLI cover it), on for hookless agents', () => {
  const saved = process.env.KORA_MCP; delete process.env.KORA_MCP;
  try {
    assert.equal(mcpEnabledFor('claude'), false, 'claude default off — doctor must not flag its absence as a problem');
    assert.equal(mcpEnabledFor('gemini'), true, 'a hookless agent gets MCP as its discoverable channel');
    process.env.KORA_MCP = '1'; assert.equal(mcpEnabledFor('claude'), true, 'KORA_MCP=1 enables it');
    process.env.KORA_MCP = '0'; assert.equal(mcpEnabledFor('gemini'), false, 'KORA_MCP=0 forces off everywhere');
  } finally { if (saved === undefined) delete process.env.KORA_MCP; else process.env.KORA_MCP = saved; }
});
