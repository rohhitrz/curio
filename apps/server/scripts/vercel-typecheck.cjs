// Type-checks the server the way Vercel's Node builder does, so a deploy can't fail on a type
// error that `pnpm typecheck` doesn't see. The builder differs from `tsc` in three ways:
//   - it reads this folder's tsconfig.json on its own and, because `module` isn't set in that
//     file itself, forces `strict: false` and target ES2021;
//   - it checks file by file in one language service, starting from the entrypoint;
//   - some global types (e.g. fetch's `Response`) come out empty there.
// Run with `pnpm --filter @curio/server typecheck:vercel`.
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const cwd = process.cwd();
const ts = createRequire(cwd + '/')('typescript');

const configFileName = ts.findConfigFile(cwd, ts.sys.fileExists);
const config = ts.readConfigFile(configFileName, ts.sys.readFile).config;
config.files = [];
config.include = [];
config.compilerOptions = Object.assign({}, config.compilerOptions, {
  sourceMap: true,
  inlineSourceMap: false,
  inlineSources: true,
  declaration: false,
  noEmit: false,
  outDir: '$$ts-node$$',
});
const co = config.compilerOptions;
if (co.target === undefined) co.target = 'ES2021';
if (co.esModuleInterop === undefined) co.esModuleInterop = true;
if (co.module === undefined) {
  co.module = 'NodeNext';
  co.moduleResolution = 'NodeNext';
  co.strict = false;
}
const parsed = ts.parseJsonConfigFileContent(
  config,
  ts.sys,
  path.dirname(configFileName),
  undefined,
  configFileName,
);

const versions = new Map();
const contents = new Map();
const host = {
  getScriptFileNames: () => [...versions.keys()],
  getScriptVersion: (f) => String(versions.get(f) ?? ''),
  getScriptSnapshot(f) {
    let c = contents.get(f);
    if (c === undefined) {
      c = ts.sys.readFile(f);
      if (c === undefined) return;
      versions.set(f, 1);
      contents.set(f, c);
    }
    return ts.ScriptSnapshot.fromString(c);
  },
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  getDirectories: ts.sys.getDirectories,
  fileExists: ts.sys.fileExists,
  directoryExists: ts.sys.directoryExists,
  getNewLine: () => ts.sys.newLine,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getCurrentDirectory: () => cwd,
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: () => ts.getDefaultLibFilePath(parsed.options),
  resolveModuleNames: (names, containing) =>
    names.map((n) => ts.resolveModuleName(n, containing, parsed.options, ts.sys).resolvedModule),
};
const service = ts.createLanguageService(
  host,
  ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, cwd),
);
const ignore = [6059, 18002, 18003];

// Entrypoint first, then its imports, as the builder compiles them.
const seen = new Set();
const order = [];
(function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  order.push(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from '(\.[^']+)\.js'/g)) {
    const dep = path.resolve(path.dirname(file), m[1] + '.ts');
    if (fs.existsSync(dep)) walk(dep);
  }
})(path.join(cwd, 'src/index.ts'));

let failed = 0;
for (const file of order) {
  const code = fs.readFileSync(file, 'utf8');
  versions.set(file, (versions.get(file) || 0) + 1);
  contents.set(file, code);
  const diags = service
    .getSemanticDiagnostics(file)
    .concat(service.getSyntacticDiagnostics(file))
    .filter((d) => !ignore.includes(d.code));
  for (const d of diags) {
    failed++;
    const { line, character } = d.file
      ? d.file.getLineAndCharacterOfPosition(d.start)
      : { line: 0, character: 0 };
    console.log(
      `${path.relative(cwd, file)}(${line + 1},${character + 1}): TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160)}`,
    );
  }
}
console.log(`${order.length} files checked, ${failed} errors`);
process.exit(failed ? 1 : 0);
