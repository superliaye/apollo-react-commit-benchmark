const repositoryRoot = new URL('../', import.meta.url);

const requiredFiles = [
  'README.md',
  'index.html',
  'favicon.svg',
  '.gitignore',
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
  if (path.startsWith('.git/') || path.startsWith('.isaac/')) continue;
  publicTextFiles.set(path, await Bun.file(new URL(path, repositoryRoot)).text());
}

for (const path of requiredFiles) {
  if (!publicTextFiles.has(path)) await readRequiredFile(path);
}

const html = publicTextFiles.get('index.html') ?? '';
const readme = publicTextFiles.get('README.md') ?? '';
const benchmarkSource = publicTextFiles.get('src/benchmark.ts') ?? '';
const errors: string[] = [];

const requiredElementIds = [
  'react-version',
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
  'headline-context',
  'trace-provenance',
];

for (const id of requiredElementIds) {
  if (!html.includes(`id="${id}"`)) errors.push(`index.html is missing required element #${id}`);
}

const requiredSections = [
  'Run the proof in this browser',
  'Watch one result spread across the screen.',
  'The code paths explain the measured task timeline.',
];

for (const section of requiredSections) {
  if (!html.includes(section)) errors.push(`index.html is missing required section: ${section}`);
}

const expectedSectionIds = ['run-lab', 'trace', 'mechanism'];
const actualSectionIds = [...html.matchAll(/<section\b[^>]*>/g)].flatMap((match) => {
  const openingTag = match[0];
  const classes = openingTag.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [];
  if (!classes.includes('section')) return [];
  return [openingTag.match(/\bid="([^"]+)"/)?.[1] ?? 'MISSING_ID'];
});
if (JSON.stringify(actualSectionIds) !== JSON.stringify(expectedSectionIds)) {
  errors.push(
    `index.html must contain only the three focused sections in order: ${expectedSectionIds.join(', ')}`,
  );
}

const resultsPosition = html.indexOf('id="summary-body"');
const verdictPosition = html.search(/\bclass="[^"]*\bverdict-card\b[^"]*"/);
if (resultsPosition < 0 || verdictPosition < 0 || resultsPosition > verdictPosition) {
  errors.push('index.html must show benchmark numbers before the proof verdict');
}

const requiredReadmeContent = [
  '## The result',
  '## The causal chain',
  '## What Q and D mean',
  'Q — query-result commit',
  'D — derived parent-state commit',
  '## How the benchmark tests causality',
  '## Why extra commits can cost time',
  '## What is measured',
  '## Run locally',
  '## Scope',
  'not another GraphQL result or another Apollo cache write',
  'creates one delivery, not N',
  'other query shapes, fetch policies, or React releases follow this exact path',
];
for (const content of requiredReadmeContent) {
  if (!readme.includes(content)) errors.push(`README.md is missing required explanation: ${content}`);
}

const requiredClaims = [
  'The 400-row default gives each React commit substantial real DOM work without adding a synthetic delay.',
  'Numbers first',
  'Q — query-result commit',
  'D — derived parent-state commit',
  'D models downstream React work; it is not another Apollo result.',
  'p50 is the median measured sample.',
  'Before a run, the strips illustrate the expected eight-subscriber pattern.',
  'The live timeline verifies separate host tasks, observer callbacks, microtasks, and commits.',
];

for (const claim of requiredClaims) {
  if (!html.includes(claim)) errors.push(`index.html is missing required interpretation: ${claim}`);
}

for (const id of ['headline-369', 'headline-314', 'headline-patched']) {
  if (!new RegExp(`id="${id}"[^>]*>—<`).test(html)) {
    errors.push(`index.html must leave #${id} empty until a browser run completes`);
  }
}
if (!html.includes('id="headline-context">populated after Run proof<')) {
  errors.push('index.html must label the pre-run headline values as unpopulated');
}

const removedSections = [
  'With multiple consumers, Apollo 3.14.1 can split one cache update across more React commits.',
  'Remove network noise. Keep the real React pressure.',
  'Three arms ask one falsifiable question.',
  'What the benchmark does—and does not—establish',
  'Terms used in this lab',
];
for (const section of removedSections) {
  if (html.includes(section)) errors.push(`index.html still duplicates README content: ${section}`);
}

const declaredIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
for (const match of html.matchAll(/href="#([^"]+)"/g)) {
  if (!declaredIds.has(match[1])) errors.push(`index.html links to missing anchor #${match[1]}`);
}

if (!/id="rows"[^>]*value="400"/.test(html)) errors.push('index.html must default to 400 DOM rows per subscriber');
if (!benchmarkSource.includes("document.querySelector<HTMLInputElement>('#rows')?.value ?? '400'")) {
  errors.push('src/benchmark.ts must fall back to 400 DOM rows per subscriber');
}
const pinnedRuntimeBlocks = [
  `label: "React 18.3.1",
            reactVersion: "18.3.1",
            reactDomPackageVersion: "18.3.1",
            expectedReactDomVersion: "18.3.1-next-f1338f8080-20240426",`,
  `label: "React 19.2.0",
            reactVersion: "19.2.0",
            reactDomPackageVersion: "19.2.0",
            expectedReactDomVersion: "19.2.0",`,
];
for (const [index, version] of ['React 18.3.1', 'React 19.2.0'].entries()) {
  if (!html.includes(version)) errors.push(`index.html must offer the pinned runtime ${version}`);
  if (!readme.includes(version)) errors.push(`README.md must document the pinned runtime ${version}`);
  if (!html.includes(pinnedRuntimeBlocks[index])) {
    errors.push(`index.html runtime table must retain the exact package and validation pins for ${version}`);
  }
}
if (!benchmarkSource.includes("nextUrl.searchParams.set('react', reactVersionSelect.value)")) {
  errors.push('src/benchmark.ts must reload the page when the React runtime changes');
}
for (const [parameter, selector] of [
  ['blocks', '#blocks'],
  ['subscribers', '#subscribers'],
  ['rows', '#rows'],
]) {
  if (!benchmarkSource.includes(`['${parameter}', '${selector}']`)) {
    errors.push(`src/benchmark.ts must preserve the ${parameter} control across a React runtime reload`);
  }
}
if (!html.includes('Changing React runtime reloads the page so packages from different React releases cannot mix.')) {
  errors.push('index.html must explain runtime isolation');
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
    if (candidate === 'http://www.w3.org/2000/svg') continue;
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
  config?: { renderedRowsPerSubscriber?: number };
  proofPassed?: boolean;
  samples?: unknown[];
};
if (referenceResult.proofPassed !== true) errors.push('Reference result does not have proofPassed=true');
if (referenceResult.samples?.length !== 96) errors.push('Reference result must contain exactly 96 samples');
if (referenceResult.config?.renderedRowsPerSubscriber !== 40) {
  errors.push('Reference result must retain its reviewed 40-row configuration');
}
if (!readme.includes('reviewed React 18.3.1 96-sample result collected with 40 rows per subscriber')) {
  errors.push('README.md must distinguish the 40-row reference result from the 400-row browser default');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  throw new Error(`Content check failed with ${errors.length} error(s)`);
}

console.log(
  `Content check passed: ${publicTextFiles.size} public text files, three focused benchmark sections, a 400-row default, and a 96-sample passing reference run.`,
);
