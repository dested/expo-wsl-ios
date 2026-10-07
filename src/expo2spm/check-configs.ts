// Parse every spm.config.json under a node_modules with the strict schema (run on SDK upgrades).
import { Glob } from 'bun';
import { z } from 'zod';
import { spmConfig, spmProduct, spmTarget } from './spm-config.ts';

const strict = z.object({ $schema: z.string().optional(), products: z.array(spmProduct.extend({ targets: z.array(spmTarget.strict()) }).strict()) }).strict();
const root = process.argv[2] ?? '';
let n = 0;
for await (const f of new Glob('**/spm.config.json').scan(root)) {
  n++;
  const r = strict.safeParse(await Bun.file(`${root}/${f}`).json());
  if (!r.success) console.log(f, JSON.stringify(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)));
  else spmConfig.parse(r.data);
}
console.log(`${n} configs checked`);
