import { readFileSync, writeFileSync } from 'node:fs';
import { planScreen } from '../../js/wii-layout.js';
const dir = process.argv[2]; const gt = JSON.parse(readFileSync(`${dir}/gt.json`)); const out = {};
for (const id of Object.keys(gt)) { const p = planScreen(JSON.parse(readFileSync(`${dir}/dump/${id}.json`)), { extraNames: ['bob', 'dog man'] }); out[id] = { kind: p.kind, pitch: p.pitch, textH: p.textH, slots: p.slots.map((s) => ({ place: s.place, row: s.rowBox, name: s.cells.name, points: s.cells.points })) }; }
writeFileSync(`${dir}/plans.json`, JSON.stringify(out));
