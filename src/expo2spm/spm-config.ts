// Expo's spm.config.json (expo/expo tools/src/prebuilds/SPMConfig.types.ts, sdk-57), parsed at the
// boundary. It is the one model every native package is reduced to: Expo's own configs, the
// external-configs shipped in expo-modules-autolinking, our overrides, and converted podspecs.
// Field semantics: plans/2026-10-07-expo-spm-generator.md section 1.
import { z } from 'zod';

const flagList = z.array(z.string());
// An array, or split by language.
const languageFlags = z.union([flagList, z.object({ c: flagList.optional(), cxx: flagList.optional() })]);
const compilerFlags = z.union([
  flagList,
  z.object({ common: languageFlags.optional(), debug: languageFlags.optional(), release: languageFlags.optional() }),
]);

const fileMapping = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(['header', 'source', 'symlink']),
});

const resource = z.union([
  z.string(),
  z.object({ path: z.string(), rule: z.enum(['process', 'copy']).optional() }),
]);

export const spmTarget = z.object({
  type: z.enum(['swift', 'objc', 'cpp', 'framework']),
  name: z.string(),
  moduleName: z.string().optional(),
  path: z.string(),
  pattern: z.string().optional(),
  headerPattern: z.string().optional(),
  exclude: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  includeDirectories: z.array(z.string()).optional(),
  fileMapping: z.array(fileMapping).optional(),
  moduleMapContent: z.string().optional(),
  publicHeaders: z.boolean().optional(),
  compilerFlags: compilerFlags.optional(),
  linkerFlags: z.array(z.string()).optional(),
  linkedFrameworks: z.array(z.string()).optional(),
  resources: z.array(resource).optional(),

  // expo-wsl-ios extensions (never in Expo's files; produced by the podspec converter and overrides).
  /** Explicit source files relative to `path`; replaces `pattern` (podspec globs don't reduce to one). */
  files: z.array(z.string()).optional(),
  /** Explicit public headers relative to `path`; replaces `headerPattern`. Staged flattened, as Expo does. */
  headers: z.array(z.string()).optional(),
  /** Swift-only flags (OTHER_SWIFT_FLAGS); compilerFlags reach Swift only as -Xcc. */
  swiftFlags: z.array(z.string()).optional(),
  /** CocoaPods resource_bundles: bundle name -> globs relative to the package root. The bundle is
   *  placed at the .app root as <name>.bundle, where pods look for it via Bundle.main. */
  resourceBundles: z.record(z.string(), z.array(z.string())).optional(),
  /** This objc target #imports "<module>-Swift.h" of the named swift target in the same product
   *  (a mixed pod's ObjC -> Swift edge); it builds after that target and sees its generated header. */
  importsSwiftHeaderOf: z.string().optional(),
});
export type SpmTarget = z.infer<typeof spmTarget>;

export const spmProduct = z.object({
  name: z.string(),
  podName: z.string().optional(),
  codegenName: z.string().optional(),
  platforms: z.array(z.string()).optional(),
  externalDependencies: z.array(z.string()).optional(),
  swiftLanguageVersions: z.array(z.string()).optional(),
  excludeFromUmbrella: z.array(z.string()).optional(),
  textualHeaders: z.array(z.string()).optional(),
  sourceOnly: z.boolean().optional(),
  autolinkWhen: z.unknown().optional(),
  customBuild: z.object({ script: z.string(), output: z.string().optional() }).optional(),
  /** Remote SwiftPM packages. Expo ships each one prebuilt in npm as
   *  prebuilds/spm-deps/<productName>/<flavor>/<productName>.xcframework. */
  spmPackages: z.array(z.looseObject({ productName: z.string().optional() })).optional(),
  targets: z.array(spmTarget),
});
export type SpmProduct = z.infer<typeof spmProduct>;

export const spmConfig = z.object({
  $schema: z.string().optional(),
  products: z.array(spmProduct),
});
export type SpmConfig = z.infer<typeof spmConfig>;

export type Flavor = 'debug' | 'release';

/** The flags for one flavor and language, from any of compilerFlags' shapes. */
export function resolveCompilerFlags(flags: SpmTarget['compilerFlags'], flavor: Flavor, lang: 'c' | 'cxx'): string[] {
  if (!flags) return [];
  if (Array.isArray(flags)) return flags;
  const pick = (f: z.infer<typeof languageFlags> | undefined): string[] =>
    f === undefined ? [] : Array.isArray(f) ? f : (f[lang] ?? []);
  return [...pick(flags.common), ...pick(flags[flavor])];
}
