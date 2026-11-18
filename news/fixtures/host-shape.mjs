// The public host-name shape from the pattern list itself (tools/audit/patterns.json, id host-ws-n), so no test
// writes it out: the stand-in name pattern of the checker's internal-name tests.
import { readFileSync } from 'node:fs';

const list = JSON.parse(readFileSync(new URL('../../tools/audit/patterns.json', import.meta.url), 'utf8'));
const shape = list.patterns.find((p) => p.id === 'host-ws-n');
if (!shape) throw new Error('tools/audit/patterns.json has no host-ws-n pattern');

/** A fresh RegExp of the host shape with the given flags. */
export const hostShape = (flags = '') => new RegExp(shape.source, flags);
