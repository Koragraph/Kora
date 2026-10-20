// @effect-diagnostics nodeBuiltinImport:off - Knip hands us plain paths; the TypeScript host is synchronous.
/**
 * Knip preprocessor: an exported Effect Schema that nothing imports is not dead code here. Schemas are the wire
 * contract (decoded on the other side of a socket, or kept for a persisted shape), so this drops "unused export"
 * findings whose every symbol is a schema. It reads types only and never runs the project's modules.
 */
import * as NodePath from "node:path";
import type { Preprocessor } from "knip";
// Knip still needs the classic compiler API, which TypeScript 7 dropped.
import ts from "typescript-legacy";

/** Every Effect 4 schema (aliases and Schema.Class constructors included) has a property with this literal type. */
const SCHEMA_MARK = "~effect/Schema/Schema";
const CATEGORIES = ["exports", "nsExports", "duplicates"] as const;

function loadProject(configPath: string | undefined, files: ReadonlyArray<string>): ts.Program {
  let options: ts.CompilerOptions = {};
  if (configPath !== undefined) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        },
      },
    );
    const problems =
      parsed?.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")) ?? [];
    if (problems.length > 0) throw new Error(problems.join("\n"));
    options = parsed?.options ?? {};
  }
  return ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    allowJs: true,
    ...options,
    noEmit: true,
  });
}

/** The names `file` exports whose value is a schema. */
function schemaExports(program: ts.Program, file: string): Set<string> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const names = new Set<string>();
  if (!source || !moduleSymbol) return names;
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const own = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    // `export type X` next to a private `const X` schema: look the value up by name.
    const value =
      own.flags & ts.SymbolFlags.Value
        ? own
        : checker.resolveName(symbol.name, source, ts.SymbolFlags.Value, false);
    if (!value) continue;
    const mark = checker
      .getTypeOfSymbolAtLocation(value, value.valueDeclaration ?? source)
      .getProperty(SCHEMA_MARK);
    const markType = mark && checker.getTypeOfSymbolAtLocation(mark, source);
    if (markType?.isStringLiteral() && markType.value === SCHEMA_MARK) names.add(symbol.name);
  }
  return names;
}

const keepSchemas: Preprocessor = (options) => {
  const absolute = (file: string) => NodePath.resolve(options.cwd, file);
  // Findings grouped by the tsconfig that owns each file, so each project is type-checked once.
  const byConfig = new Map<string | undefined, Set<string>>();
  for (const category of CATEGORIES) {
    for (const [file, found] of Object.entries(options.issues[category])) {
      if (Object.keys(found).length === 0) continue;
      const config = ts.findConfigFile(NodePath.dirname(absolute(file)), ts.sys.fileExists);
      byConfig.set(config, (byConfig.get(config) ?? new Set()).add(file));
    }
  }
  for (const [config, files] of byConfig) {
    const program = loadProject(config, [...files].map(absolute));
    for (const file of files) {
      const schemas = schemaExports(program, absolute(file));
      for (const category of CATEGORIES) {
        const found = options.issues[category][file];
        if (!found) continue;
        for (const [key, issue] of Object.entries(found)) {
          const names = (issue.symbols ?? [{ symbol: issue.symbol }]).map((s) => s.symbol);
          if (names.length === 0 || !names.every((n) => schemas.has(n))) continue;
          delete found[key];
          options.counters[category]--;
        }
        if (Object.keys(found).length === 0) delete options.issues[category][file];
      }
    }
  }
  return options;
};

export default keepSchemas;
