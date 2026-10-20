// A short, hand-checked starter list. Every entry is a server its maintainers publish; Kora only fills in the
// command. Parameters are asked for when the entry is added; `secret` ones go to the keychain.
import type { McpServer } from './model';

export interface CatalogParam {
  key: string;
  label: string;
  /** Where the value goes: an env var, an HTTP header (value template allowed), or appended as an argument. */
  kind: 'env' | 'header' | 'arg';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  /** For headers: the value with `{value}` where the input goes, e.g. `Bearer {value}`. */
  template?: string;
  help?: string;
}

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  homepage: string;
  /** What must be installed for it to start. */
  needs: 'node' | 'uv' | null;
  server: Omit<McpServer, 'enabled' | 'agents' | 'workers'>;
  params: CatalogParam[];
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'github', title: 'GitHub', needs: null, homepage: 'https://github.com/github/github-mcp-server',
    description: 'Issues, pull requests, code search and Actions through GitHub\'s hosted server.',
    server: { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    params: [{ key: 'Authorization', label: 'Personal access token', kind: 'header', template: 'Bearer {value}', secret: true, required: true, placeholder: 'github_pat_…', help: 'github.com/settings/tokens (fine-grained, with the repositories it may use)' }],
  },
  {
    id: 'context7', title: 'Context7', needs: 'node', homepage: 'https://github.com/upstash/context7',
    description: 'Current library documentation and examples, fetched by version.',
    server: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    params: [{ key: 'CONTEXT7_API_KEY', label: 'API key (optional, raises rate limits)', kind: 'env', secret: true }],
  },
  {
    id: 'playwright', title: 'Playwright', needs: 'node', homepage: 'https://github.com/microsoft/playwright-mcp',
    description: 'Drive a real browser: open pages, click, fill forms, read the accessibility tree.',
    server: { name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    params: [],
  },
  {
    id: 'chrome-devtools', title: 'Chrome DevTools', needs: 'node', homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    description: 'Inspect and debug a page in Chrome: console, network, performance traces.',
    server: { name: 'chrome-devtools', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    params: [],
  },
  {
    id: 'filesystem', title: 'Filesystem', needs: 'node', homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    description: 'Read and write files in folders you name (outside the project an agent is working in).',
    server: { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    params: [{ key: 'folder', label: 'Folder it may use', kind: 'arg', required: true, placeholder: '~/Documents/notes' }],
  },
  {
    id: 'fetch', title: 'Fetch', needs: 'uv', homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    description: 'Fetch a URL and return it as markdown.',
    server: { name: 'fetch', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    params: [],
  },
  {
    id: 'git', title: 'Git', needs: 'uv', homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    description: 'Read history, diffs and blame of a repository.',
    server: { name: 'git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
    params: [],
  },
  {
    id: 'memory', title: 'Memory', needs: 'node', homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    description: 'A small knowledge graph the agent can store facts in and recall later.',
    server: { name: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    params: [],
  },
  {
    id: 'sequential-thinking', title: 'Sequential thinking', needs: 'node', homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    description: 'A scratchpad tool for step-by-step reasoning on hard problems.',
    server: { name: 'sequential-thinking', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    params: [],
  },
  {
    id: 'notion', title: 'Notion', needs: 'node', homepage: 'https://github.com/makenotion/notion-mcp-server',
    description: 'Search, read and edit the Notion pages an integration can see.',
    server: { name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    params: [{ key: 'NOTION_TOKEN', label: 'Integration token', kind: 'env', secret: true, required: true, placeholder: 'ntn_…', help: 'notion.so/profile/integrations' }],
  },
  {
    id: 'sentry', title: 'Sentry', needs: 'node', homepage: 'https://github.com/getsentry/sentry-mcp',
    description: 'Issues, events and stack traces from Sentry.',
    server: { name: 'sentry', transport: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server@latest'] },
    params: [{ key: 'SENTRY_ACCESS_TOKEN', label: 'User auth token', kind: 'env', secret: true, required: true, placeholder: 'sntryu_…' }],
  },
  {
    id: 'supabase', title: 'Supabase', needs: 'node', homepage: 'https://github.com/supabase-community/supabase-mcp',
    description: 'Query and inspect a Supabase project (read-only by default).',
    server: { name: 'supabase', transport: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'] },
    params: [
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal access token', kind: 'env', secret: true, required: true, placeholder: 'sbp_…' },
      { key: '--project-ref', label: 'Project ref (optional: limits it to one project)', kind: 'arg', placeholder: 'abcd1234' },
    ],
  },
];

export const catalogEntry = (id: string) => CATALOG.find((e) => e.id === id) ?? null;
