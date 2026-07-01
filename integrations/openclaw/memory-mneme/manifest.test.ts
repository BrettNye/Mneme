import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

describe('memory-mneme plugin manifest and package', () => {
  it('parses openclaw.plugin.json with correct shape', () => {
    const manifestPath = join(__dirname, 'openclaw.plugin.json');
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);

    // Check kind
    expect(manifest.kind).toBe('memory');

    // Check configSchema contains all required keys
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema).toHaveProperty('dbPath');
    expect(manifest.configSchema).toHaveProperty('corpus');
    expect(manifest.configSchema).toHaveProperty('autoRecall');
    expect(manifest.configSchema).toHaveProperty('recallLimit');
    expect(manifest.configSchema).toHaveProperty('relevanceFloor');
    expect(manifest.configSchema).toHaveProperty('defaultScope');

    // Check tools array
    expect(manifest.tools).toBeDefined();
    expect(Array.isArray(manifest.tools)).toBe(true);
    const toolNames = manifest.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual([
      'memory_recall',
      'memory_remember',
      'memory_key_census',
      'memory_corpora',
    ]);
  });

  it('parses package.json with correct shape', () => {
    const packagePath = join(__dirname, 'package.json');
    const content = readFileSync(packagePath, 'utf-8');
    const pkg = JSON.parse(content);

    // Check type
    expect(pkg.type).toBe('module');

    // Check openclaw extensions
    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toBeDefined();
    expect(pkg.openclaw.extensions).toEqual(['./index.ts']);

    // Check dependencies
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies.mneme).toBeDefined();
    expect(pkg.dependencies.mneme).toContain('file:');
    expect(pkg.dependencies['@sinclair/typebox']).toBeDefined();
  });

  it('README.md contains required documentation', () => {
    const readmePath = join(__dirname, 'README.md');
    const content = readFileSync(readmePath, 'utf-8');

    // Check for slot configuration
    expect(content).toContain('plugins.slots.memory');

    // Check for better-sqlite3 prerequisite
    expect(content).toContain('better-sqlite3');
  });
});
