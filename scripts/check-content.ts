const repositoryRoot = new URL('../', import.meta.url);

const requiredFiles = [
  'README.md',
  'index.html',
  'benchmark.js',
  'package.json',
  'src/benchmark.ts',
  'src/shared-observer-delivery-task-patch.ts',
  'results/reference-run.json',
  'scripts/check-content.ts',
  '.github/workflows/pages.yml',
  '.nojekyll',
];

const readRequiredFile = async (path: string): Promise<string> => {
  const file = Bun.file(new URL(path, repositoryRoot));
  if (!(await file.exists())) throw new Error(`Missing required file: ${path}`);
  return file.text();
};

const repositoryPath = decodeURIComponent(repositoryRoot.pathname);
const publicTextFiles = new Map<string, string>();
for await (const path of new Bun.Glob('**/*').scan({ cwd: repositoryPath, dot: true, onlyFiles: true })) {
  if (path.startsWith('.git/')) continue;
  publicTextFiles.set(path, await Bun.file(new URL(path, repositoryRoot)).text());
}

for (const path of requiredFiles) {
  if (!publicTextFiles.has(path)) await readRequiredFile(path);
}

const html = publicTextFiles.get('index.html') ?? '';
const errors: string[] = [];

const requiredElementIds = [
  'blocks',
  'subscribers',
  'rows',
  'run',
  'status',
  'verdict',
  'proof-conditions',
  'environment',
  'summary-body',
  'advanced-summary-body',
  'trace-strips',
  'trace-body',
  'raw-result',
  'headline-369',
  'headline-314',
  'headline-patched',
];

for (const id of requiredElementIds) {
  if (!html.includes(`id="${id}"`)) errors.push(`index.html is missing required element #${id}`);
}

const requiredSections = [
  'What ordinary Apollo code this represents',
  'From cache publication to committed, paintable UI',
  'Three-arm experiment',
  'Run the proof in this browser',
  'See one result fragment across the screen',
  'Why the newer version can split one update',
  'What the benchmark does—and does not—establish',
];

for (const section of requiredSections) {
  if (!html.includes(section)) errors.push(`index.html is missing required section: ${section}`);
}

const requiredGlossaryIds = [
  'term-stock',
  'term-diagnostic-patch',
  'term-subscriber',
  'term-cache-write',
  'term-observable-query',
  'term-observer-delivery',
  'term-notification',
  'term-host-task',
  'term-microtask',
  'term-react-commit',
  'term-component-render',
  'term-derived-state',
  'term-layout-effect',
  'term-react-cpu',
  'term-geometry-read',
  'term-final-commit',
  'term-paint',
  'term-p50',
  'term-p90',
  'term-balanced-block',
  'term-proof-condition',
  'term-snapshot',
  'term-logical-notification',
  'term-delivery-batch',
  'term-default-lane',
  'term-sync-lane',
];

for (const id of requiredGlossaryIds) {
  if (!html.includes(`id="${id}"`)) errors.push(`index.html is missing glossary definition #${id}`);
}

const termLinks = [...html.matchAll(/href="#(term-[^"]+)"/g)].map((match) => match[1]);
for (const id of new Set(termLinks)) {
  if (!html.includes(`id="${id}"`)) errors.push(`Glossary link #${id} has no matching definition`);
}

const requiredClaims = [
  'One cache write. Same data. 8× more React commits.',
  'The stable result is the commit pattern.',
  'This patch is evidence, not a release recommendation.',
  'no synthetic busy loop or artificial “commit tax.”',
];

for (const claim of requiredClaims) {
  if (!html.includes(claim)) errors.push(`index.html is missing required interpretation: ${claim}`);
}

const allowedPublicHosts = new Set([
  'bun.sh',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'github.com',
  'superliaye.github.io',
]);
const absoluteUserPath = /(?:^|[\s"'`(])\/(?:home|Users)\/[^/\s"'`)]+/gm;
const urlPattern = /https?:\/\/[^\s"'<>)}]+/g;
const secretPatterns = [
  new RegExp(['gh', 'o_'].join(''), 'i'),
  new RegExp(['BEGIN ', 'PRIVATE KEY'].join(''), 'i'),
  new RegExp(['authorization', ':\\s*bearer'].join(''), 'i'),
];

for (const [path, content] of publicTextFiles) {
  if (absoluteUserPath.test(content)) errors.push(`${path} contains an absolute user path`);
  absoluteUserPath.lastIndex = 0;

  for (const candidate of content.match(urlPattern) ?? []) {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !allowedPublicHosts.has(url.hostname)) {
      errors.push(`${path} links to a non-allowlisted or non-HTTPS host: ${url.hostname}`);
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) errors.push(`${path} contains a credential-like pattern`);
    pattern.lastIndex = 0;
  }
}

const referenceResult = JSON.parse(publicTextFiles.get('results/reference-run.json') ?? '{}') as {
  proofPassed?: boolean;
  samples?: unknown[];
};
if (referenceResult.proofPassed !== true) errors.push('Reference result does not have proofPassed=true');
if (referenceResult.samples?.length !== 96) errors.push('Reference result must contain exactly 96 samples');

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  throw new Error(`Content check failed with ${errors.length} error(s)`);
}

console.log(
  `Content check passed: ${publicTextFiles.size} public text files, ${requiredGlossaryIds.length} glossary definitions, ${
    new Set(termLinks).size
  } linked terms, and a 96-sample passing reference run.`,
);
