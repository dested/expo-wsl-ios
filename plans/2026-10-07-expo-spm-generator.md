# Expo's spm.config.json → Package.swift → XCFramework pipeline (research)

Status: active (research)

Source read: `expo/expo` `tools/src/prebuilds/*`. **Use the `sdk-57` branch** (head `8c03ac548e`,
last prebuild commit `9838edd228`). It matches our RN 0.86.3. `main` has moved on to RN 0.87:
`db43bf359e` deleted the React VFS overlay path, and `main` added checked-in-manifest support
(`CheckedInManifest.ts`) and the `expo-modules-macros` package rename. Snippets below are from
`sdk-57` unless they say `main`. Cross-checked against `fixtures/hello-expo/node_modules` and
`bland/apps/kidsize25/node_modules` (read only).

Pipeline (`pipeline/ProductSteps.ts`): `generateStep` → `buildStep` → `composeStep` → `verifyStep`,
run per `package/product@flavor`, one at a time.

```
Codegen.ensureCodegenAsync(pkg)                       // only if package.json has codegenConfig
SPMGenerator.generateIsolatedSourcesForTargetsAsync()  // stage symlinks + hardlinked headers
SPMGenerator.generateSwiftPackageAsync()              // -> SPMPackage.writePackageSwiftAsync
SPMBuild.buildSwiftPackageAsync(..., hermesIncludeDirs) // xcodebuild per platform
Frameworks.composeXCFrameworkAsync()                  // -create-xcframework + header/modulemap/swiftinterface surgery
FrameworkVerifier.verifyXCFrameworkAsync()            // xcrun/otool/lipo/plutil/codesign, Mac-only
```

Paths (`SPMPackageSource`, `ExternalPackage.ts`):
- `pkg.path` is the package source (the npm dir). For external packages, the config lives in
  `expo-modules-autolinking/external-configs/ios/<npm-name>/spm.config.json` and the sources come
  from `resolvePackagePath(name)`.
- `pkg.buildPath = <precompile>/.build/<npm-name>`.
- Staging dir: `<buildPath>/generated/<Product>/`, with `Package.swift` at its root
  (`SPMGenerator.getSwiftPackagePath`).
- DerivedData: `<buildPath>/output/<flavor>/frameworks/<Product>/` (`SPMBuild.getPackageBuildPath`).
- XCFramework: `<buildPath>/output/[<pkgVer>/<rnVer>/<hermesVer>/]<flavor>/xcframeworks/<Product>.xcframework`
  (`Frameworks.getFrameworkPath`). The version prefix applies only to external packages
  (`outputVersionPrefix`).
- RN artifact cache: `<cache>/{hermes,react,react-native-dependencies}/<ver>/<flavor>/`, fetched from
  Maven Central (`Artifacts.ts`): `com/facebook/hermes/hermes-ios`,
  `com/facebook/react/react-native-artifacts` (`reactnative-core-<flavor>.tar.gz`,
  `reactnative-dependencies-<flavor>.tar.gz`).

## 1. Field semantics and Package.swift emission

### Product-level fields

| field | consumed by | effect |
|---|---|---|
| `name` | everywhere | Library product name (`.library(name:, type: .dynamic, targets: [all product.targets])`), staging dir, xcframework name, final clang/Swift module name |
| `podName` | `Utils.validatePodNamesAsync`, `precompiled_modules.rb` | Must match a `.podspec`. Consumer side only |
| `platforms` | `generatePackageSwiftContent`, `getBuildPlatformsFromProductPlatform` | Emitted verbatim as `.${p}`, so `iOS("16.4")` becomes `.iOS("16.4")`. `iOS(...)` builds `iOS` + `iOS Simulator` |
| `externalDependencies` | `buildPackageSwiftContext` | Become **binary targets** in the package (see below). The product list does **not** produce compiler flags; flags come from each target's own `dependencies` |
| `swiftLanguageVersions` | package-level `swiftLanguageVersions: [.version("6.0")]` | |
| `excludeFromUmbrella` | `Frameworks.createModuleMapWithUmbrellaHeaderFilesAsync` | Glob (only `*` and `?`) on the flattened header name. The header still ships in `Headers/` but is left out of `<P>_umbrella.h`, so Swift consumers can't see it |
| `textualHeaders` | same | If set, the umbrella header is **replaced** by an explicit `header "x.h"` list plus `textual header` lines, and `module * { export * }` is dropped |
| `codegenName` | `precompiled_modules.rb` only | Tells the app-side ReactCodegen to drop this library's generated sources (to avoid duplicate symbols). The generator doesn't read it. `Codegen.ts` reads `package.json` `codegenConfig.name` |
| `sourceOnly` | `pipeline/RunSteps.ts` (`if (product.sourceOnly) continue;`) | Never prebuilt |
| `autolinkWhen` | `precompiled_modules.rb` only | Decides whether CocoaPods links a companion pod |
| `customBuild {script, output}` | `CustomBuild.ts` | Runs a package script instead of the generator (ExpoModulesJSI: `apple/scripts/build-xcframework.sh`) |
| `spmPackages` | `buildPackageSwiftContext` | Adds `.package(url:, exact:/from:/branch:/revision:)`. A target dependency on its `productName` becomes `.product(name:, package:)`. A prebuilt shared copy, if present, is used as a `.binaryTarget` instead (`Frameworks.getSharedSPMDepFrameworkPath`) |
| `publishPrebuilds` | release tooling | |

### Target-level fields (`SPMGenerator.generateIsolatedSourcesForTargetsAsync`, `SPMPackage.resolveSourceTarget`/`buildCSettings`/`buildSwiftSettings`)

| field | semantics |
|---|---|
| `type` | `swift` → `.target` + `swiftSettings`. `objc`/`cpp` → `.target` + `publicHeadersPath: "include"` + `cSettings` + `cxxSettings` (identical sets for both). `framework` → `.binaryTarget(path: relative(pkg.path/target.path))`. On the generated side, objc and cpp differ only in default `pattern` |
| `name` | SwiftPM target name **and** its module name during the build (for example `ExpoModulesCore_ios_objc`). Staged at `generated/<Product>/<name>/`, emitted as `path: "<name>"`, `sources: nil` |
| `path` | Relative to `pkg.path`. A `.build/` prefix makes it relative to `pkg.buildPath` instead, which is how codegen output gets in: `target.path.slice('.build/'.length)` joined to `buildPath` |
| `pattern` | Glob for sources, run with cwd = the source path. Each match is **symlinked** into the staging dir at the same relative path. Defaults: cpp `**/*.{cpp,c,cc,cxx}`, objc `**/*.{m,mm,c,cpp}`, swift `**/*.swift`. Stale symlinks are pruned |
| `headerPattern` | Headers are staged **only if this is set**. Each match is **hardlinked, flattened to basename**, into `generated/<P>/<target>/include/<moduleName ?? Product>/<basename>` (`getHeaderFilesPath`, `refreshHardlinkIfNeeded`). Hardlinks keep `#pragma once` working, since inode equality matters. The basename flattening means collisions silently overwrite |
| `exclude` | glob `ignore` + always `'**/Tests/**'` (`getTargetExcludePatterns`) |
| `moduleName` | The header staging subdir (defaults to the product name). It adds an extra `.headerSearchPath("include/<moduleName>")`. When it differs from the product name, compose puts its headers under `Headers/<moduleName>/` as a **submodule** |
| `dependencies` | Strings. Each one is (a) emitted as a target dependency: `"X"`, or `.product(name:"X", package:"p")` if X is an `spmPackages` product; (b) for objc/cpp/swift, **the list `collectVfsAndHeaderMapFlags` scans** (case-insensitive `hermes`/`react`/`reactnativedependencies`) to emit header flags; (c) when it names a sibling product, an external `pkg/Product`, or an external package product such as `RNWorklets`, the source of `-I <thatXCFramework>/<slice>/<X>.framework/Headers` (objc/cpp only, `xcframeworkPaths`); (d) for swift, the trigger for the macro plugin when it is `ExpoModulesCore` or ends in `/ExpoModulesCore`; (e) when it names an in-product target, an `@_exported import <dep>` in `<Product>+Exports.swift` |
| `pkg/Product`, `@scope/pkg/Product` | Becomes `.binaryTarget(name: "expo-modules-core/ExpoModulesCore", path: rel(<precompile>/.build/<pkg>/output/<flavor>/xcframeworks/<Product>.xcframework))`. **The target name literally contains `/`**. The xcframework must already exist, so build in topological order. `expandTransitiveExternalDeps` + `resolveExternalDepsFromMonorepo` pull in that product's own `externalDependencies` with a BFS, so a dep on ExpoModulesCore also brings in `expo-modules-jsi/ExpoModulesJSI` |
| `Hermes` / `React` / `ReactNativeDependencies` | `ARTIFACT_RELATIVE_PATHS` (see the React section). Binary targets `Hermes` → `hermes/<v>/<flavor>/destroot/Library/Frameworks/universal/hermesvm.xcframework`, `React` → `react/<v>/<flavor>/React.xcframework`, `ReactNativeDependencies` → `.../ReactNativeDependencies.xcframework` |
| `includeDirectories` | objc/cpp only. Each entry → `-I <abs>`, resolved against `path.resolve(targetRoot, target.path, dir)`. Anything that lands in `pkg.path/.build/...` is remapped to `pkg.buildPath/...`. These point at the **original source tree**, not the staging dir, so quoted includes into subdirs keep working. Swift targets ignore the field |
| `fileMapping` | `header`: copy (not link) matches of `from` into `generated/<P>/<target>/include/<to with {filename}>`, plus `.headerSearchPath("include/<dirname(to)>")`. `source`: symlink into `<target>/<to>`. `symlink`: a directory symlink inside `include/`, `include/<to>` → `include/<from>` (screens: `include/react/renderer/components/rnscreens` → `include/rnscreens`). Mapped files are skipped by the normal pattern copy |
| `moduleMapContent` | Written to `generated/<P>/<target>/include/module.modulemap`. That is SwiftPM's custom-modulemap slot, which suppresses the auto-generated one. If the target's moduleName ≠ product and the content contains `textual header`, compose marks the whole submodule textual |
| `publicHeaders: false` | Drops `publicHeadersPath`, so no module is built for the target |
| `compilerFlags` | `resolveCompilerFlags`: an array, or `{common,debug,release}`, each either an array or `{c,cxx}`. The flavor is picked at **generate** time. objc/cpp: `-DNAME[=V]` → `.define("NAME", to: "V")` (propagates to dependents), everything else → `.unsafeFlags([...])`. `${PACKAGE_VERSION}` and `${REACT_NATIVE_MINOR_VERSION}` are substituted. swift: the **c** flags pass as `-Xcc <flag>` unsafeFlags, with no `${}` substitution |
| `linkerFlags` | `linkerSettings: [.unsafeFlags([...])]` |
| `linkedFrameworks` | `.linkedFramework("X")`. For swift targets, also `@_exported import X` in the Exports file |
| `resources` | Globbed from `pkg.path`, copied flat into `<target>/resources/`, emitted as `.process("resources/<basename>")` (or `.copy`). Compose copies `<pkg.packageName>_<target>.bundle` next to the `.framework` in each slice |

### Emitted Package.swift (verbatim template, `SPMPackage.generatePackageSwiftContent`)

```ts
lines.push('// swift-tools-version: 5.9');
...
lines.push('let package = Package(');
lines.push(`    name: "${context.packageName}",`);      // npm name, e.g. "expo-modules-core"
lines.push('    platforms: [');  context.platforms.map((p) => `        .${p}`)
lines.push(`        .library(`);
lines.push(`            name: "${product.name}",`);
lines.push(`            type: .dynamic,`);
lines.push(`            targets: [${targetsList}]`);    // every target in product.targets
...
    lines.push(`    swiftLanguageVersions: [${versions}],`);
lines.push('    cxxLanguageStandard: .cxx20');
```

Target order: externals (binary), then `framework` targets (binary), then sibling products
(binary), then source targets in config order. A source target is always:

```ts
lines.push(`        .target(`);
lines.push(`            name: "${target.name}",`);
lines.push(`            dependencies: [${deps}],`);
lines.push(`            path: "${target.path}",`);   // == target.name
lines.push(`            sources: nil,`);
// resources: [.process("resources/x")]
// objc/cpp: publicHeadersPath: "include", cSettings: [...], cxxSettings: [...]
// swift: swiftSettings: [...]
// linkerSettings: [.linkedFramework("X"), .unsafeFlags([...])]
```

`buildCSettings` (objc and cpp; `cxxSettings` gets the same list):

```ts
cSettings.push(`.headerSearchPath("include")`);
cSettings.push(`.headerSearchPath("include/${productName}")`);
// + .headerSearchPath("include/<moduleName>") if moduleName != product
// + .headerSearchPath("include/<dirname(fileMapping.to)>") per header mapping
cSettings.push('.define("RCT_NEW_ARCH_ENABLED", to: "1")');
cSettings.push('.define("RCT_REMOVE_LEGACY_ARCH", to: "1")');
cSettings.push('.unsafeFlags(["-fmodules"])');   // deliberately NOT -fcxx-modules
// + .unsafeFlags(["-I", <abs includeDirectories>...])
// + .unsafeFlags(["-I", <depXCFW>/<slice>/<X>.framework/Headers], .when(configuration: .debug|.release))
// + compilerFlags: .define(...) / .unsafeFlags([...])
// + VFS/header flags, .when(configuration: .debug) and .when(configuration: .release)
```

`buildSwiftSettings`:

```ts
settings.push('.enableUpcomingFeature("LibraryEvolution")');   // cosmetic; real switch is BUILD_LIBRARY_FOR_DISTRIBUTION
settings.push('.define("RCT_NEW_ARCH_ENABLED")');
settings.push('.define("RCT_REMOVE_LEGACY_ARCH")');
pushUnsafeFlags([settings], ['-Xcc', '-fmodules']);
// if target is ExpoModulesCore or depends on (*/)ExpoModulesCore:
//   ['-Xfrontend','-load-plugin-executable','-Xfrontend', `${macrosToolPath}#ExpoModulesMacros`]
//   sdk-57: <expo-modules-core>/node_modules/@expo/expo-modules-macros-plugin/apple/ExpoModulesMacros-tool
//   main:   <expo-modules-core>/node_modules/expo-modules-macros/apple/ExpoModulesMacros
// VFS/header flags each wrapped '-Xcc', per configuration
// compilerFlags.c each wrapped '-Xcc'
```

`<Product>+Exports.swift` (staged into every swift target):

```swift
// This file is auto-generated by SPMGenerator.ts

@_exported import Foundation        // one per linkedFrameworks
@_exported import UIKit
@_exported import ExpoModulesCore_common_cpp   // one per in-product target dependency
@_exported import ExpoModulesCore_ios_objc
```

Rendered example for expo-asset. I reconstructed this by tracing the code; the tool was not run.

```swift
let package = Package(
    name: "expo-asset",
    platforms: [ .iOS("16.4") ],
    products: [ .library(name: "ExpoAsset", type: .dynamic, targets: ["ExpoAsset"]) ],
    targets: [
        .binaryTarget(name: "ReactNativeDependencies", path: "<rel>/react-native-dependencies/0.86.3/debug/ReactNativeDependencies.xcframework"),
        .binaryTarget(name: "React", path: "<rel>/react/0.86.3/debug/React.xcframework"),
        .binaryTarget(name: "Hermes", path: "<rel>/hermes/<hv>/debug/destroot/Library/Frameworks/universal/hermesvm.xcframework"),
        .binaryTarget(name: "expo-modules-core/ExpoModulesCore", path: "<rel>/expo-modules-core/output/debug/xcframeworks/ExpoModulesCore.xcframework"),
        .binaryTarget(name: "expo-modules-jsi/ExpoModulesJSI", path: "<rel>/expo-modules-jsi/output/debug/xcframeworks/ExpoModulesJSI.xcframework"),
        .target(
            name: "ExpoAsset",
            dependencies: ["Hermes", "React", "ReactNativeDependencies", "expo-modules-core/ExpoModulesCore", "expo-modules-jsi/ExpoModulesJSI"],
            path: "ExpoAsset",
            sources: nil,
            swiftSettings: [
                .enableUpcomingFeature("LibraryEvolution"),
                .define("RCT_NEW_ARCH_ENABLED"),
                .define("RCT_REMOVE_LEGACY_ARCH"),
                .unsafeFlags(["-Xcc", "-fmodules"]),
                .unsafeFlags([
                    "-Xfrontend", "-load-plugin-executable",
                    "-Xfrontend", "<emc>/node_modules/@expo/expo-modules-macros-plugin/apple/ExpoModulesMacros-tool#ExpoModulesMacros",
                ]),
                .unsafeFlags([
                    "-Xcc", "-ivfsoverlay",
                    "-Xcc", "<cache>/react/0.86.3/debug/React-VFS.yaml",
                    "-Xcc", "-I",
                    "-Xcc", "<cache>/react/0.86.3/debug/React.xcframework/Headers",   // VFS root
                    "-Xcc", "-I",
                    "-Xcc", "<cache>/react/0.86.3/debug/React.xcframework/Headers",
                    "-Xcc", "-I",
                    "-Xcc", "<cache>/react/0.86.3/debug/React.xcframework/React_Core",
                    "-Xcc", "-I",
                    "-Xcc", "<cache>/react-native-dependencies/0.86.3/debug/ReactNativeDependencies.xcframework/Headers",
                ], .when(configuration: .debug)),
                // same block for release
            ],
            linkerSettings: [ .linkedFramework("Foundation") ]
        )
    ],
    cxxLanguageStandard: .cxx20
)
```

The binary-target paths are flavor-specific, so Package.swift is regenerated for each flavor. The
`-I` flags cover both flavors via `.when`. Every flag path is absolute, because
`SPM passes .unsafeFlags -I values directly to the compiler ... relative to its own CWD`.

### How React headers are reached (sdk-57 = RN ≤0.86: VFS overlay)

`SPMPackage.collectVfsAndHeaderMapFlags`. For each target dependency that matches an
`ARTIFACT_RELATIVE_PATHS` key:
- `react` (`vfsOverlayFile: 'React-VFS.yaml'`, `includeDirectories: ['Headers','React_Core']`):
  `-ivfsoverlay <base>/React-VFS.yaml`, then `-I <first roots[].name in the yaml>`
  (`extractVFSOverlayRootPath`, which is `<React.xcframework>/Headers`), then
  `-I <React.xcframework>/Headers`, `-I <React.xcframework>/React_Core`.
- `reactnativedependencies`: `-I <ReactNativeDependencies.xcframework>/Headers`.
- `hermes`: **no flags in Package.swift.** Its `destroot/include` holds `jsi/` headers that clash with
  React's VFS `jsi/`. Instead `ProductSteps.buildStep` passes
  `hermesIncludeDirs = [<hermes>/destroot/include]`, and `SPMBuild` appends them as `-I` to
  `OTHER_CFLAGS`/`OTHER_CPLUSPLUSFLAGS` and `-Xcc -I` to `OTHER_SWIFT_FLAGS`. The comment says this
  keeps them "invisible to the Clang dependency scanner".

`React-VFS.yaml` comes from `Dependencies.resolveVFSOverlayTemplate`: it does
`template.replace(/\$\{ROOT_PATH\}/g, <abs React.xcframework>)` on `React-VFS-template.yaml`. For RN
0.85+ that template **ships inside `React.xcframework/`** (`TransformReactXCFramework`: "RN 0.85+
ships React-VFS-template.yaml inside the xcframework with fully nested headers"). For older RN it is
synthesized from podspecs (`ReactVFSOverlay.ts`, `ReactHeaderMappings.ts`) along with a
`React-extra-headers/` staging dir. Overlay root: `name: '${ROOT_PATH}/Headers'`, `case-sensitive: false`.
For us that's one `sed` with our absolute Linux path.

On `main` (RN 0.87+), React gets `-fmodule-map-file=<ReactNativeHeaders.xcframework>/<slice>/Headers/module.modulemap -I <thatHeaders>`
instead (`collectHeaderMapFlags`). Keep this behind a seam for SDK 58.

### One module name: what actually happens (no VFS, no `-import-underlying-module`)

During the SwiftPM build, every target is its **own** module:
- `ExpoModulesCore_common_cpp` and `ExpoModulesCore_ios_objc` are clang modules. Each gets the module
  map SwiftPM synthesizes from `publicHeadersPath: "include"`. The layout is `include/ExpoModulesCore/*.h`,
  so there is no `include/<target>.h` umbrella and SwiftPM falls back to an umbrella **directory**.
  `-fmodules` without `-fcxx-modules` means `.m` TUs import modularly while `.mm`/`.cpp` include
  textually.
- The `ExpoModulesCore` swift target sees the ObjC/C++ declarations only through the generated
  `ExpoModulesCore+Exports.swift`: `@_exported import ExpoModulesCore_ios_objc` / `..._common_cpp`.
- `#import <ExpoModulesCore/X.h>` resolves because every objc/cpp target has `-I include`, and
  SwiftPM adds each dependency's public `include/` to its dependents. All of a product's targets
  stage headers under the same `include/<Product>/` subdir.
- The product is `type: .dynamic`, so all of the targets link into one
  `PackageFrameworks/ExpoModulesCore.framework`.

`Frameworks.composeXCFrameworkAsync` merges them **after** the build:
1. `collectAndCopyHeaderFilesFromBuiltFrameworksAsync` copies every objc/cpp target's
   `include/<moduleName>/**.h` from the **staging dir** (not the build output). Product-module headers
   go flat into `Headers/`. moduleName≠product headers go to `Headers/<moduleName>/`, and
   `rewriteHeaderImportsForSubmodulesAsync` turns `<Mod/X.h>` into `"Mod/X.h"` or `"X.h"`.
2. `createModuleMapWithUmbrellaHeaderFilesAsync` writes `Modules/module.modulemap` and
   `Headers/<P>_umbrella.h` (`#import "x.h"` per non-excluded, non-textual header). Template:
   ```
   framework module ${productName} {
       use React                       // only if externalDependencies includes "React"
       umbrella header "${productName}_umbrella.h"   // or explicit header/textual header list if textualHeaders
       header "${productName}-Swift.h"  // if any swift target

       export *
       module * { export * }           // only with umbrella
       module ${moduleName} { header "${moduleName}/x.h" ... export * }   // per moduleName != product
       export ${moduleName}
   }
   module ${moduleName} { export ${productName}.${moduleName} }   // top-level alias
   ```
   The shipped `ExpoModulesCore.xcframework` (kidsize25 `prebuilds/output/release`) matches this exactly:
   `framework module ExpoModulesCore { use React / umbrella header "ExpoModulesCore_umbrella.h" / header "ExpoModulesCore-Swift.h" / export * / module * { export * } }`.
3. `copySwiftModuleInterfacesAsync` copies `Build/Products/<Cfg>-<sdk>/<swiftTarget.name>.swiftmodule/*`,
   **skipping binary `*.swiftmodule`** (interfaces, swiftdoc, abi.json only). Then
   `fixSwiftInterfaceModuleReferencesAsync` rewrites `import <targetName>`,
   `@_exported import <targetName>` and `<targetName>.` to the product name. The shipped interface
   therefore reads `@_exported import ExpoModulesCore` twice, a self-import that the compiler resolves
   to the framework's own clang module (normal mixed-framework behaviour). It still carries
   `-enable-library-evolution ... -enable-upcoming-feature LibraryEvolution ... -module-name ExpoModulesCore -package-name expomodulescore`
   and `-formal-cxx-interoperability-mode=off`.
4. `copyGeneratedObjCSwiftHeaderAsync` copies `Intermediates.noindex/GeneratedModuleMaps-<sdk>/<P>-Swift.h`
   into `Headers/`. `fixObjCSwiftHeaderModuleReferencesAsync` comments out `@import <internalTarget>;`
   (same product), rewrites other products' internal targets to `@import <OtherProduct>;`, and
   comments out `@import React;`.

Upshot: the "single module" is post-hoc text surgery. The swiftinterface typechecks only if every
ObjC/C++ type its public API mentions lives in a header that is in the umbrella. Expo's `Verifier`
typechecks it on the Mac. On Linux we'd have to reproduce that check (`swiftc -typecheck-module-from-interface`).

## 2. Running the generator standalone

`SPMGenerator`/`SPMPackage` are pure Node (fs/glob/path). They only shell out for codegen
(`node`), never to Xcode. Their non-local imports, transitive through `Frameworks.ts` and `Utils.ts`:

| import | used for | stub |
|---|---|---|
| `../Logger` (default) | verbose logs | `console`, trivial |
| `../Directories`: `getPrecompileDir`, `getExternalPackagesDir`, `getExpoRepositoryRootDir` | build root; external-configs dir; repo root (resolvePackage, SPMBuild prefix maps) | constants: our build root, `node_modules/expo-modules-autolinking/external-configs/ios`, app root. Trivial |
| `../Packages`: `getPackageByName`, `Package` (`.path`, `.hasSwiftPMConfiguration()`, `.getSwiftPMConfiguration()`), `getListOfPackagesAsync` | macro-plugin path, transitive `pkg/Product` deps, discovery | ~30 lines: `require.resolve('<n>/package.json')` + read `spm.config.json`. Trivial |
| `./resolvePackage` → `apps/bare-expo` | RN path, codegen path | rewrite to resolve from the app root. Trivial |
| `./Utils`: `createAsyncSpinner`, `SpinnerError`, `hasFileContentChanged` (+ `ora`, `AsyncLocalStorage`) | UI | no-op spinner object `{info,succeed,fail,warn}`. Trivial |
| `./Frameworks`: `getFrameworkPath`, `computeVersionPrefixForDependency`, `getSharedSPMDepFrameworkPath` | xcframework path math | copy these 3 pure functions. Importing the module would drag in `SPMBuild` → `XCodeRunner` → `@expo/xcpretty`. **Cut this edge** |
| `./ExternalPackage`: `getExternalPackageByProductName`, `SPMPackageSource` | product → external pkg lookup | keep (pure). It uses the `Directories`/`Packages` stubs |
| `./Artifacts.types` `DownloadedDependencies` | type only | keep |
| npm: `fs-extra`, `glob`, `chalk`, `@expo/spawn-async`, `semver` | | Bun-compatible |

Things to fix while vendoring:
- **`any`**: `catch (e: any)` in `getReactNativeMinorVersion`/`getPackageVersion`/`Codegen.runCodegenAsync`,
  plus casts (`artifactPaths[config.artifactKey] as string`, `as ObjcTarget | ...`). Sal's no-`any`
  rule means narrowing to `unknown` and parsing configs with zod.
- **Hard-coded nested macro path** (`<expo-modules-core>/node_modules/@expo/expo-modules-macros-plugin`).
  In our installs it is hoisted to top-level `node_modules/@expo/...`, and it is a **Mach-O universal
  binary**. See the gotchas.
- **Global caches**: `_reactNativeMinorVersion` and `_packageVersionCache` are module-level.

Effort: vendor `SPMConfig.types.ts`, `SPMPackage.types.ts`, `SPMGenerator.ts` (467 lines),
`SPMPackage.ts` (1618), `SPMIdentifier.ts`, `Codegen.ts` (268), `VersionStamp.ts`, and
`resolveVFSOverlayTemplate` (~25 lines), about 2.5k LOC, plus ~150 lines of shims. That takes
**0.5–1 day** to strict-tsc-clean. Porting the compose half (the `Frameworks.ts` functions
`collectAndCopyHeaderFiles…`, `createModuleMapWithUmbrellaHeaderFiles…`,
`fixSwiftInterfaceModuleReferences…`, `fixObjCSwiftHeaderModuleReferences…`,
`rewriteHeaderImportsForSubmodules…`, `copyResourceBundles…`, about 450 LOC, all pure fs) is
**about 1 day**. `xcodebuild -create-xcframework` gets replaced by our existing Info.plist writer
(`scripts/pack-jsi-xcframework.sh`). MIT licence.

## 3. SPMBuild: the xcodebuild invocation

`SPMBuild.buildXcodeBuildArgs`, run with cwd = the staging dir (`XCodeRunner.spawnXcodeBuildWithSpinner`
→ `spawn('xcodebuild', args, { cwd })`), once per build platform (`iOS`, `iOS Simulator`):

```ts
'-scheme', pkg.packageName,                       // SwiftPM auto-scheme = Package(name:)
'-destination', `generic/platform=${buildPlatform}`,
'-derivedDataPath', <buildPath>/output/<flavor>/frameworks/<Product>,
'-configuration', buildType,                      // Debug | Release
'SKIP_INSTALL=NO',
...(containsSwiftTargets ? ['BUILD_LIBRARY_FOR_DISTRIBUTION=YES'] : []),
...(Release ? ['GCC_PREPROCESSOR_DEFINITIONS=$(inherited) NDEBUG=1 NS_BLOCK_ASSERTIONS=1']
            : ['GCC_PREPROCESSOR_DEFINITIONS=$(inherited) DEBUG=1']),
'DEBUG_INFORMATION_FORMAT=dwarf-with-dsym',
`OTHER_CFLAGS=$(inherited) ${allCPrefixMaps} -I<hermes>/destroot/include`,
`OTHER_CPLUSPLUSFLAGS=$(inherited) ${allCPrefixMaps} -I<hermes>/destroot/include`,
`OTHER_SWIFT_FLAGS=$(inherited) ${allSwiftPrefixMaps} ${allXccPrefixMaps} -Xcc -I<hermes>/destroot/include`,  // swift only
'build',
```

Prefix maps: `-fdebug-prefix-map=<repoRoot>=/expo-src`, plus per target
`-fdebug-prefix-map=<staging>/<target>/=/expo-src/packages/<pkg>/<target.path>/`. Swift gets
`-debug-prefix-map ...` and `-Xcc -fdebug-prefix-map=...`. These only make dSYMs portable; they are
optional for us. **The `NDEBUG=1` in Release is load-bearing**: "Without NDEBUG in Release, React
Native headers expose non-inline symbols (e.g. Sealable) that the Release React.xcframework doesn't
export."

Outputs that compose reads:
- binary: `Build/Products/<Cfg>-<iphoneos|iphonesimulator>/PackageFrameworks/<P>.framework` (a
  dynamic **framework** bundle, because `type: .dynamic`)
- dSYM: `Build/Products/<Cfg>-<sdk>/<P>.framework.dSYM`
- swiftmodule: `Build/Products/<Cfg>-<sdk>/<swiftTarget>.swiftmodule/`
- `-Swift.h`: `Build/Intermediates.noindex/GeneratedModuleMaps-<sdk>/<P>-Swift.h`
- resources: `Build/Products/<Cfg>-<sdk>/<packageName>_<target>.bundle`

Then: `xcodebuild -create-xcframework -framework <f> [-debug-symbols <dSYM>] ... -output <xcfw>`;
copy headers, modulemap and interfaces into each slice; delete the top-level `Headers/`; optionally
`codesign`; `tar -czf <P>.tar.gz`.

`spmPackages` only: `resolveSPMDependenciesAndPatch` runs `swift package resolve`, then patches
`Reachability.swift` for library evolution. `buildSharedSPMDependencyAsync` rebuilds remote packages
as `.framework`s and `enrichFrameworkWithHeaders` repairs their Headers and Modules.

Inherently Xcode-only: `xcodebuild` itself (scheme, destination), `-create-xcframework`, the
PackageFrameworks bundle layout, `Verifier` (`xcrun`, `plutil`, `otool`, `lipo`, `codesign`) and
`dSYM.ts`. Everything else is plain file plumbing.

Our SwiftBuild equivalent, from `scripts/spike-jsi.sh` / `pack-jsi-xcframework.sh`:
- products land at `.build/out/Products/<Cfg>-iphoneos/lib<P>.dylib`, a **bare dylib, not a
  `.framework`**, so we wrap it ourselves.
- install name via `-Xlinker -install_name -Xlinker @rpath/<P>.framework/<P>`.
- swiftinterface at `.build/out/Intermediates.noindex/<P>.build/<Cfg>-iphoneos/<P>-t.build/Objects-normal/arm64/<P>.swiftinterface`
  (not under Products).
- `-Swift.h` at `.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos/<P>-Swift.h`, the same
  dir name that `Frameworks.copyGeneratedObjCSwiftHeaderAsync` expects.
- library evolution: `BUILD_LIBRARY_FOR_DISTRIBUTION` has no CLI equivalent. Inject
  `.unsafeFlags(["-enable-library-evolution", "-emit-module-interface"])` into swiftSettings, as
  `expo-modules-jsi/apple/Package.swift` does.
- `GCC_PREPROCESSOR_DEFINITIONS` and Hermes `OTHER_*FLAGS` become `-Xcc -DNDEBUG=1 -Xcc -DNS_BLOCK_ASSERTIONS=1`
  (`-Xcxx` likewise) and `-Xcc -I<hermes>/destroot/include` (C, C++, and `-Xswiftc -Xcc`), passed on
  the `swift build` command line or appended to the generated settings.

## 4. Codegen (`Codegen.ts`)

Runs when the package's `package.json` has `codegenConfig`, and is skipped when the outputs and
`.codegen-version-stamp` (`packageVersion`, `@react-native/codegen` version) are current. Exact command:

```
cd <react-native> && node <react-native>/scripts/generate-codegen-artifacts.js \
  -p <pkg.path> -t ios -o <pkg.buildPath>/codegen -s library
```

(`spawnAsync('node', [codegenScript, '-p', pkg.path, '-t', 'ios', '-o', outputPath, '-s', 'library'], { cwd: reactNativePath })`.)
RN 0.86.3's script accepts these flags (`-p/-t/-o/-s`, plus `-f` forceOutputPath, which isn't used).
Expected outputs:
`<buildPath>/codegen/build/generated/ios/ReactCodegen/react/renderer/components/<codegenConfig.name>/Props.h`
(components) and `<buildPath>/codegen/build/generated/ios/ReactCodegen/<name>/<name>.h` (modules).
Configs refer to them as `.build/codegen/build/generated/ios/ReactCodegen/...`. The `.build/` prefix
means `pkg.buildPath`, so `pkg.buildPath` **must** be `<root>/.build/<npm-name>`, or you must keep
the remap. Screens example: the targets `RNScreens_codegen_components` (cpp, moduleName `rnscreens`)
and `RNScreens_codegen_modules` (objc) compile the generated `.cpp`/`.mm`. The include dir
`../.build/generated/RNScreens/RNScreens_common_cpp/include/rnscreens` points into **another target's
staging dir**, so staging has to finish before compiling.

## 5. App-side consumption (covered, but CocoaPods-only)

- `expo-modules-autolinking/scripts/ios/precompiled_modules.rb` (`EXPO_USE_PRECOMPILED_MODULES=1`,
  which requires `RCT_USE_PREBUILT_RNCORE=1`) swaps each pod for a podspec with
  `vendored_frameworks = <Product>.xcframework`, sourced from the `.tar.gz`. Debug and release
  tarballs both live in `artifacts/`, and a script phase swaps them per configuration. Post-install it:
  - writes `React-use-frameworks.modulemap` (`module React { umbrella header ".../React.xcframework/Headers/React_Core/React_Core-umbrella.h" export * }`)
  - strips `framework module React` from React.framework's modulemaps
  - injects `-fmodule-map-file=<that>` + `-isystem <React.xcframework>/Headers` (and `-Xcc` forms)
    into every pod and aggregate xcconfig. The comment: "Module builds don't inherit -I but DO inherit -isystem".
  - adds ExpoModulesJSI header search paths
  - drops codegen sources for prebuilt libraries (via `codegenName`) from `ReactCodegen`
    (`configure_codegen_for_prebuilt_modules`)
  - stubs out compile phases of pods bundled inside xcframeworks
- `ExpoModulesProvider.swift` is independent of prebuilds. It is generated by
  `node --eval "require('expo/bin/autolinking')" expo-modules-autolinking generate-modules-provider --target <path>/ExpoModulesProvider.swift --target-name <App> --platform apple --packages <names…>`
  (`project_integrator.rb`), and emits `internal import ExpoModulesCore`,
  `internal import <EachModule>` and `class ExpoModulesProvider: ModulesProvider { getModuleClasses() … }`.
  It compiles into the app target.
- Prebuilt availability today (kidsize25, SDK 57): only `expo-modules-core` (ExpoModulesCore,
  ExpoModulesWorklets), `expo-file-system` and `expo-font` ship
  `prebuilds/output/<flavor>/xcframeworks/*.tar.gz`. Every other Expo package with an
  `spm.config.json` (asset, audio, haptics, linking, symbols, system-ui, `@expo/ui`, …) and all
  external configs (screens, reanimated, worklets, svg, safe-area, async-storage, skia) must be built
  by us.

## Recommendation

**Vendor `SPMGenerator` + `SPMPackage` (+ types, Codegen, VFS-template resolve) from `sdk-57`,
pinned to `9838edd228`, behind a ~150-line shim. Reimplement the build and compose halves.**
The npm configs are co-versioned with the tool on that branch, and the semantics are subtle: the
`.build/` remaps, per-target versus per-product external deps, define/unsafeFlags splitting,
transitive `pkg/Product` expansion, and fileMapping symlinks. A clean-room subset would drift on
exactly the packages we care about (screens, reanimated, skia). The build half is xcodebuild-shaped
and has to be rewritten for `swift build --build-system swiftbuild` anyway. Port the compose
functions verbatim, since they are pure fs, and swap `-create-xcframework` for our plist writer.
When we move to SDK 58, re-vendor from `main`, where the VFS is replaced by `ReactNativeHeaders.xcframework`.

## Gotchas (ranked)

1. **The macro plugin is a Mach-O binary.** `ExpoModulesMacros-tool` is a universal x86_64/arm64
   macOS executable, and `-load-plugin-executable` runs it **on the build host**. Build it for Linux
   from `@expo/expo-modules-macros-plugin/apple` (swift-syntax 602, `.macro` target), then point the
   flag at it. The hard-coded path is also nested-node_modules and doesn't match our hoisted install.
   This affects every target that depends on ExpoModulesCore.
2. **Library evolution and `NDEBUG` come from xcodebuild settings, not from Package.swift.**
   `.enableUpcomingFeature("LibraryEvolution")` alone produces no `.swiftinterface`. Inject
   `-enable-library-evolution -emit-module-interface`, and for Release also
   `-DNDEBUG=1 -DNS_BLOCK_ASSERTIONS=1`. Without the latter you get undefined `Sealable`-style
   symbols against the release React.xcframework.
3. **Hermes include ordering and the dependency scanner.** Hermes `-I` is kept out of Package.swift
   on purpose (its `jsi/` clashes with the React VFS), so it must be appended as an `-Xcc`/`OTHER_*`
   style flag. If SwiftBuild on Linux enables explicit modules (the clang/swift dependency scan),
   expect the same jsi duplicate-definition class of errors Expo dodged. Check whether
   `-ivfsoverlay` + `case-sensitive: false` behaves the same on ext4.
4. **Output layout differs.** SwiftBuild emits `lib<P>.dylib` (not
   `PackageFrameworks/<P>.framework`) and keeps the swiftinterface in `Objects-normal/arm64`, so we
   wrap frameworks ourselves. Every product needs its own `-install_name @rpath/<P>.framework/<P>`,
   so either build one product per invocation or put the install name into the product's
   `linkerSettings`. Resource bundle names (`<packageName>_<target>.bundle`, needed for
   `Bundle.module`) must be verified under SwiftBuild, since system-ui and svg use resources.
5. **Merge-by-text-surgery.** Internal targets are separate modules at build time, and the
   single-module illusion is created afterwards: the swiftinterface `import` rewrite, the `-Swift.h`
   `@import` removal, and the hand-written `framework module` with `use React`. Port all four
   rewrites, or consumers fail with "no such module ExpoModulesCore_ios_objc". Then typecheck each
   interface on Linux (`swiftc -typecheck-module-from-interface`), because Expo's Verifier that
   catches this is Mac-only.

Also: binary target names contain `/` (`"expo-modules-core/ExpoModulesCore"`); verify SwiftBuild's
PIF accepts that, or rename to the product name in the shim. Header staging uses **hardlinks**, so
the staging root must be on the same filesystem as `node_modules` (ext4, not `/mnt/g`), or you get
EXDEV. Products must be built in dependency order, because generation `throw`s if a dependent
xcframework is missing. `headerPattern` flattens to the basename, so the last colliding file wins.
