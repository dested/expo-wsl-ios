// Static-archive surgery for prebuilt xcframeworks, without lipo or libtool (Linux has neither).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_ARM64 = 0x0100000c;

/** The plain arm64 archive inside a universal (fat) one; the input itself when it's already thin. */
export function thinArm64(file: Buffer): Buffer {
  const magic = file.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return file;
  const wide = magic === FAT_MAGIC_64;
  const entry = wide ? 32 : 20;
  for (let i = 0; i < file.readUInt32BE(4); i++) {
    const at = 8 + i * entry;
    const cpuSubtype = file.readUInt32BE(at + 4) & 0xff;
    // arm64 proper (subtype ALL), not arm64e.
    if (file.readUInt32BE(at) !== CPU_TYPE_ARM64 || cpuSubtype !== 0) continue;
    const offset = wide ? Number(file.readBigUInt64BE(at + 8)) : file.readUInt32BE(at + 8);
    const size = wide ? Number(file.readBigUInt64BE(at + 16)) : file.readUInt32BE(at + 12);
    return file.subarray(offset, offset + size);
  }
  throw new Error('universal archive has no arm64 slice');
}

async function llvmAr(args: string[]): Promise<string> {
  const p = Bun.spawn(['llvm-ar', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`llvm-ar ${args.slice(0, 2).join(' ')}: ${err}`);
  return out;
}

/** The device slice's static archive in an xcframework, or undefined (dynamic framework, no device slice). */
function deviceArchive(xcframework: string): { slice: string; file: string } | undefined {
  const slice = readdirSync(xcframework).find((d) => d.startsWith('ios-') && !d.includes('simulator'));
  if (slice === undefined) return undefined;
  const file = readdirSync(join(xcframework, slice)).find((f) => f.endsWith('.a'));
  return file === undefined ? undefined : { slice, file };
}

/**
 * Copies of a product's static xcframeworks in which each archive member appears only in the first
 * archive that has it. xtool links with -all_load, which loads every member of every archive, and
 * Skia's module archives (libsvg.a, ...) each carry their own copy of Skia core. CocoaPods links
 * without -all_load, so the linker only ever takes one copy and the duplicates never collide.
 * Device slice only, thinned to arm64; cached in destDir. Returns name -> xcframework to link.
 */
export async function dedupeArchives(libs: { name: string; xcframework: string }[], destDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const done = join(destDir, '.done');
  const plan = libs.map((l) => ({ ...l, archive: deviceArchive(l.xcframework), dest: join(destDir, `${l.name}.xcframework`) }));
  if (plan.some((p) => p.archive === undefined)) return out;
  if (!existsSync(done)) {
    rmSync(destDir, { recursive: true, force: true });
    const seen = new Set<string>();
    for (const p of plan) {
      if (p.archive === undefined) continue;
      mkdirSync(join(p.dest, p.archive.slice), { recursive: true });
      cpSync(join(p.xcframework, 'Info.plist'), join(p.dest, 'Info.plist'));
      // The other slices (simulator) stay as they were.
      for (const d of readdirSync(p.xcframework)) {
        if (d !== p.archive.slice && d !== 'Info.plist') symlinkSync(join(p.xcframework, d), join(p.dest, d));
      }
      const thin = join(p.dest, p.archive.slice, p.archive.file);
      writeFileSync(thin, thinArm64(readFileSync(join(p.xcframework, p.archive.slice, p.archive.file))));
      const members = (await llvmAr(['t', thin])).split('\n').filter(Boolean);
      const dupes = [...new Set(members.filter((m) => seen.has(m)))];
      for (let i = 0; i < dupes.length; i += 400) await llvmAr(['--format=darwin', 'd', thin, ...dupes.slice(i, i + 400)]);
      for (const m of members) seen.add(m);
    }
    writeFileSync(done, '');
  }
  for (const p of plan) out.set(p.name, p.dest);
  return out;
}
