import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const problems = [];
if (!pkg.engines?.node) problems.push('engines.node is missing');
if (typeof pkg.description !== 'string' || !pkg.description.trim()) {
  problems.push('description is missing');
}
if (!pkg.repository?.url?.includes('flisk-sh/flisk-inference')) {
  problems.push('repository.url does not point at flisk-sh/flisk-inference');
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`package metadata: node ${pkg.engines.node}, ${pkg.repository.url}`);
}
