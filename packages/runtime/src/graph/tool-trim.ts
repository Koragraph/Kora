// Trimmed MCP tool surface.
//
// Koragraph's own tool descriptions are essays because in the standalone product MCP is the ONLY
// teacher: the description had to carry the whole argument for reaching for the graph instead of grep.
// Inside this runtime three other channels already do that teaching before the agent's first token —
// the rulebook block in the instruction file, the session-start brief, and the system-prompt append —
// so the schema only has to say WHICH tool answers WHICH question.
//
// Measured on the untrimmed surface: 3,319 tokens of schema + 710 of instructions, re-billed on every
// turn of every session. The long descriptions were ~85% of that and taught nothing the other three
// channels had not already said twice.
//
// What is NOT trimmed: tool names, parameter names, types, enums, defaults, required-ness. Those are
// the contract an agent calls against, and shortening a parameter's meaning is how you get a wrong call
// rather than a cheap one. Only prose is cut.

const SHORT: Record<string, string> = {
  explore: 'Start here, before grep/Read. A symbol OR a plain-English phrase returns ranked declarations plus, for the top hits, their source, callers and callees in one call.',
  search_code: 'Locate a declaration by name in the graph rather than by text. Use explore instead when you want to understand it, not just find it.',
  neighbours: 'Callers ("in") and callees ("out") of one symbol, with the line and how each edge was resolved. depth>1 walks a call chain in one call.',
  changes_with: 'What has historically shipped in the same commit as this symbol (git-mined co-change). Finds the coupled code no call edge connects.',
  blast_radius: 'Run BEFORE editing. Everything that depends on these files or symbols, and which of it has no test coverage.',
  file_symbols: 'Every declaration in one file, with line ranges.',
  overview: 'Orient in an unfamiliar repository: hubs, co-change hotspots, import cycles.',
};

// Parameter prose is cut to a clause. A parameter whose MEANING is load-bearing (an anchor choice, a
// scope that changes the answer) keeps enough words to be used correctly.
const SHORT_PARAMS: Record<string, string> = {
  query: 'Symbol name, or a short plain-English description of what you want to understand.',
  symbol: 'Symbol name: bare ("readAsCSV"), qualified ("Session.get"), or "file.go:readAsCSV".',
  file: 'Path, or a disambiguator when the symbol is declared in more than one place.',
  files_changed: 'Repository-relative paths you are about to edit.',
  path: 'Repository-relative file path.',
  direction: 'in = callers, out = callees, both = default.',
  depth: 'Hops to walk. >1 traces a call chain in one call.',
  limit: 'Maximum rows returned.',
  detail: 'concise (default) or full.',
  project_id: 'Repository or project name as overview prints it. Omit for the current repo.',
  repo: 'Repository name as overview prints it. Omit for the current repo.',
  include_cochange: 'Include statistical co-change edges (use changes_with instead, normally).',
  include_heuristic: 'Include guess-grade edges.',
  edge_types: 'Restrict to these edge types.',
};

// Parameters an agent set in 0 of 20+ measured graph calls, and which the CLI still exposes: not worth their
// schema bytes on every turn. The handler keeps accepting them; they are simply not advertised.
const DROP_PARAMS = new Set(['project_id', 'edge_types', 'include_heuristic', 'include_cochange', 'task_type', 'repo']);
function trimSchema(schema: any): any {
  if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
  const props: Record<string, any> = {};
  for (const [name, spec] of Object.entries<any>(schema.properties)) {
    if (DROP_PARAMS.has(name)) continue;
    const short = SHORT_PARAMS[name];
    props[name] = short ? { ...spec, description: short } : { ...spec, description: undefined };
    if (props[name].description === undefined) delete props[name].description;
  }
  return { ...schema, properties: props };
}

/** Trim a koragraph tool definition for the MCP surface. Untouched when KORA_FULL_SCHEMA=1. */
export function trimTool(tool: any): any {
  if (process.env.KORA_FULL_SCHEMA === '1') return tool;
  const short = SHORT[tool.name];
  if (!short) return tool;
  const out: any = { ...tool, description: short, inputSchema: trimSchema(tool.inputSchema) };
  // `title` restates the name for every tool ("Explore code" for `explore`) and is billed like anything else.
  delete out.title;
  return out;
}

/** The instruction block, shortened for the same reason: three other channels already said this. */
export function trimmedInstructions(): string {
  if (process.env.KORA_FULL_SCHEMA === '1') return '';
  return [
    'A resolved code graph of this repository, local and fast.',
    'Route by need: HOW does X work → explore (declarations + callers/callees + a source excerpt). WHO calls X / what breaks → neighbours, blast_radius (before editing). WHERE is a name → search_code (locations only, cheap).',
    'STRING references — renames, config keys, docs, log text — are grep\'s job; the graph indexes structure, not text. Do not run explore for a rename.',
    'Read source by the line range a result gives you (offset/limit), never whole files.',
    'Every tool returns file:line — read the source yourself. Once the graph has answered, trust it; re-grepping to verify is the single biggest way to waste a turn.',
    'The same tools are available as shell commands (`kora graph <tool>`), which cost nothing until called.',
  ].join(' ');
}
