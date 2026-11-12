#!/usr/bin/env node
/**
 * Generate plugin/README*.md from the repository-root README*.md files.
 *
 * The plugin market renders the README of the entry URL, and this repository is
 * listed at plugin/ — so the page shows plugin/README.md, not the project README
 * at the root. The npm page reads the same file. These copies exist so both
 * pages show the project README: the root README*.md files are the single source
 * of truth, and this script derives the five files under plugin/ from them.
 *
 * Two rewrites make the copies correct:
 *
 *  - Images are written as docs/... relative to the repository root. A copy in
 *    plugin/ would resolve them against plugin/docs/, which does not exist, so
 *    every image becomes an absolute raw.githubusercontent.com URL. That also
 *    passes the market's image allowlist (it only renders GitHub-hosted images)
 *    and works on the npm page.
 *
 *  - The GIF gallery and the roster caption are raw HTML. The market's README
 *    renderer strips raw HTML, so an <img> tag would silently disappear there.
 *    The gallery table becomes one row of markdown images with the captions on
 *    the line below, and every remaining <img>/<sub> becomes markdown too.
 *
 * Usage:
 *   node tools/sync-plugin-readmes.mjs           write plugin/README*.md
 *   node tools/sync-plugin-readmes.mjs --check   fail if the copies are stale
 *
 * CI runs --check: it regenerates in memory and compares, so editing a root
 * README without regenerating the copies fails the build instead of leaving the
 * market and npm pages stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The raw URL is absolute on purpose: the copies are read by third-party pages
// (market, npm) that do not know which repository they came from.
const REPO = 'Mng12345/dsh-desktop-pet-codex';
const RAW = `https://raw.githubusercontent.com/${REPO}/HEAD/`;

// The copies are only useful if the set matches what the market and GitHub read:
// README.md is the entry point, the four translations are linked from it.
const SOURCES = ['README.md', 'README.zh.md', 'README.ja.md', 'README.zh-tw.md', 'README.de.md'];

const absolute = (src) => RAW + src.replace(/^\.\//, '').replace(/^\//, '');

/** Turn one raw <img> tag into markdown, resolving its src against the repo root. */
function imgToMarkdown(tag) {
  const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
  const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? '';
  if (!src) throw new Error(`<img> without src: ${tag}`);
  return `![${alt}](${absolute(src)})`;
}

/** Rewrite a root README into the form the plugin market and npm can render. */
function transform(md) {
  // 1. The HTML gallery table becomes a row of markdown images; the <sub>
  //    caption row becomes a plain line below it. A markdown table would keep
  //    the columns but seven 160px images overflow the page and make the panel
  //    scroll sideways, so a wrapping row is the layout that fits.
  md = md.replace(/<table\b[^>]*>[\s\S]*?<\/table>/g, (block) => {
    const images = [...block.matchAll(/<img\b[^>]*>/g)].map((m) => imgToMarkdown(m[0]));
    if (!images.length) return block;
    const captions = [...block.matchAll(/<sub>([\s\S]*?)<\/sub>/g)].map((m) => m[1].trim());
    return images.join(' ') + (captions.length ? `\n\n*${captions.join(' · ')}*` : '');
  });

  // 2. Centered blocks: a single image, or a single caption.
  md = md.replace(/<p\b[^>]*>\s*(<img\b[^>]*>)\s*<\/p>/g, (_, tag) => imgToMarkdown(tag));
  md = md.replace(/<p\b[^>]*>\s*<sub>([\s\S]*?)<\/sub>\s*<\/p>/g, (_, text) => `*${text.trim()}*`);

  // 3. Inline <img> tags left inside markdown table cells (the state table).
  md = md.replace(/<img\b[^>]*>/g, (tag) => imgToMarkdown(tag));

  // 4. Any <sub> left outside a paragraph.
  md = md.replace(/<sub>([\s\S]*?)<\/sub>/g, (_, text) => `*${text.trim()}*`);

  // 5. Markdown images that are still relative (the settings screenshot).
  md = md.replace(/!\[([^\]]*)\]\((?!https?:)([^)\s]+)\)/g, (_, alt, src) => `![${alt}](${absolute(src)})`);

  // 6. Nothing raw may survive: the market strips it, so a leftover tag would
  //    vanish from the page without an error. Fail loudly instead.
  if (/<img\b|<table\b|<sub\b/i.test(md)) throw new Error('raw HTML survived the rewrite');
  if (/!\[[^\]]*\]\((?!https?:)/.test(md)) throw new Error('a relative image survived the rewrite');
  return md;
}

/** Build the copy for one root README, including the generated-file marker. */
function generate(source) {
  const raw = fs.readFileSync(path.join(root, source), 'utf8').replace(/\r\n/g, '\n');
  const md = transform(raw);
  const lines = md.split('\n');
  if (!lines[0].startsWith('# ')) throw new Error(`${source}: expected the title on line 1`);
  // Keep the marker below the title: the market strips the leading H1 by
  // matching it at the very start of the file, and an HTML comment is hidden on
  // GitHub and npm but stripped by the market, so this line is invisible
  // everywhere yet tells a human which file is generated.
  lines.splice(1, 0, '', `<!-- Generated from ../${source} by tools/sync-plugin-readmes.mjs; do not edit. -->`);
  return lines.join('\n');
}

const check = process.argv.includes('--check');
const stale = [];

for (const source of SOURCES) {
  let out;
  try {
    out = generate(source);
  } catch (error) {
    console.error(`sync-plugin-readmes: ${error.message}`);
    process.exit(1);
  }

  const target = path.join(root, 'plugin', source);
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== out) stale.push(`plugin/${source}`);
    continue;
  }

  fs.writeFileSync(target, out);
  console.log(`plugin/${source}  <-  ${source}`);
}

if (check) {
  if (stale.length) {
    console.error(`plugin/README copies are stale: ${stale.join(', ')}`);
    console.error('Run: node tools/sync-plugin-readmes.mjs');
    process.exit(1);
  }
  console.log('plugin/README copies match the root READMEs');
}
