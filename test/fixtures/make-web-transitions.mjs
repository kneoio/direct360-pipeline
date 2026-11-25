// Writes web-transitions.json from a direct360-web checkout (default ../direct360-web, or D360_WEB_DIR): the
// transitions the web editor's live view draws, which test/camera-transition.test.mjs holds the render to.
// node test/fixtures/make-web-transitions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { transitionCases } from './transition-cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = process.env.D360_WEB_DIR || path.resolve(here, '../../../direct360-web');
const lens = await import(pathToFileURL(path.join(webDir, 'src/editor/lens.js')));
const plan = await import(pathToFileURL(path.join(webDir, 'src/editor/plan.js')));
fs.writeFileSync(path.join(here, 'web-transitions.json'), `${JSON.stringify(transitionCases(lens, plan), null, 1)}\n`);
