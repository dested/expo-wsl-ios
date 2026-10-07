import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SpmTarget } from '../spm-config.ts';
import {
  convertPodspec,
  convertSpec,
  dependencyTokens,
  emptyRawSpec,
  expandBraces,
  expandFiles,
  listTree,
  mapPodDependency,
  type RawSpec,
  shellSplit,
  translateXcconfig,
} from './convert.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Write a fixture tree: { 'ios/A.m': '...' } under a fresh temp dir. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'expo2spm-podspec-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

const spec = (name: string, over: Partial<RawSpec>): RawSpec => ({ ...emptyRawSpec(name), ...over });
const byName = (targets: SpmTarget[], name: string): SpmTarget => {
  const t = targets.find((x) => x.name === name);
  if (!t) throw new Error(`no target ${name} in ${targets.map((x) => x.name).join(', ')}`);
  return t;
};

describe('patterns', () => {
  test('brace expansion, nested', () => {
    expect(expandBraces('ios/**/*.{h,m{,m}}')).toEqual(['ios/**/*.h', 'ios/**/*.m', 'ios/**/*.mm']);
    expect(expandBraces('a.swift')).toEqual(['a.swift']);
  });

  test('CocoaPods semantics: ** spans zero dirs, directory excludes, Tests and node_modules dropped', () => {
    const root = fixture({
      'ios/A.h': '', 'ios/A.m': '', 'ios/Sub/B.swift': '', 'ios/Sub/B.png': '',
      'ios/Unsafe/U.m': '', 'ios/Tests/T.swift': '', 'ios/Specs/S.m': '',
      'ios/node_modules/x/N.m': '', 'README.md': '',
    });
    const tree = listTree(root);
    expect(tree.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(expandFiles(tree, ['ios/**/*.{h,m,swift}'], ['ios/Unsafe'], ['ios/Specs/**/*.m'])).toEqual([
      'ios/A.h', 'ios/A.m', 'ios/Sub/B.swift',
    ]);
    // A bare directory in source_files means its source files; trailing slash and ./ are tolerated.
    expect(expandFiles(tree, ['./ios/Sub/'], [])).toEqual(['ios/Sub/B.swift']);
    expect(expandFiles(tree, ['ios/*.m', 'ios/Unsafe/*.m'], ['ios/Unsafe/'])).toEqual(['ios/A.m']);
  });

  test('shellSplit honors quotes and escapes', () => {
    expect(shellSplit(`$(inherited) "$(PODS_ROOT)/a b" -DX='1 2' \\"q`)).toEqual([
      '$(inherited)', '$(PODS_ROOT)/a b', '-DX=1 2', '"q',
    ]);
  });
});

describe('dependencies', () => {
  test('pod names map to tokens', () => {
    expect(mapPodDependency('React-Core')).toBe('React');
    expect(mapPodDependency('ReactCommon/turbomodule/core')).toBe('React');
    expect(mapPodDependency('Yoga')).toBe('React');
    expect(mapPodDependency('RCT-Folly/Fabric')).toBe('ReactNativeDependencies');
    expect(mapPodDependency('glog')).toBe('ReactNativeDependencies');
    expect(mapPodDependency('hermes-engine')).toBe('Hermes');
    expect(mapPodDependency('ExpoModulesCore')).toBe('expo-modules-core/ExpoModulesCore');
    expect(mapPodDependency('ExpoModulesJSI')).toBe('expo-modules-jsi/ExpoModulesJSI');
    expect(mapPodDependency('RNScreens')).toBe('pod:RNScreens');
  });

  test('token list: RN trio first, implied by React/ExpoModulesCore/rn_deps', () => {
    expect(dependencyTokens(['ExpoModulesCore', 'openiap'], false)).toEqual([
      'Hermes', 'React', 'ReactNativeDependencies', 'expo-modules-core/ExpoModulesCore', 'pod:openiap',
    ]);
    expect(dependencyTokens([], true)).toEqual(['Hermes', 'React', 'ReactNativeDependencies']);
    expect(dependencyTokens(['UMAppLoader'], false)).toEqual(['pod:UMAppLoader']);
  });
});

describe('xcconfig', () => {
  test('defines, flavors, swift flags, search paths', () => {
    const root = fixture({ 'cpp/x.h': '', 'lib/y.h': '' });
    const warnings: string[] = [];
    const xc = translateXcconfig(
      new Map([
        ['GCC_PREPROCESSOR_DEFINITIONS', ['$(inherited) FOO=1 BAR']],
        ['OTHER_CFLAGS', ['$(inherited) -DCOMMON']],
        ['OTHER_CFLAGS[config=*Debug*]', ['$(inherited) -DCOMMON -DDEBUG_ONLY']],
        ['OTHER_CPLUSPLUSFLAGS', ['$(inherited) -fno-rtti']],
        ['OTHER_SWIFT_FLAGS', ['$(inherited) -DSWIFTY']],
        ['HEADER_SEARCH_PATHS', [`"$(PODS_TARGET_SRCROOT)/cpp" "$(PODS_ROOT)/Headers/Private/React-Core" "\${PODS_ROOT}/../${path.basename(root)}/lib" "$(PODS_ROOT)/../elsewhere"`]],
        ['DEFINES_MODULE', ['YES']],
      ]),
      root,
      path.join(path.dirname(root), 'Pods'),
      (m) => warnings.push(m),
    );
    expect(xc.cc.common.c).toEqual(['-DFOO=1', '-DBAR', '-DCOMMON']);
    expect(xc.cc.common.cxx).toEqual(['-DFOO=1', '-DBAR', '-DCOMMON', '-fno-rtti']);
    expect(xc.cc.debug.c).toEqual(['-DDEBUG_ONLY']);
    expect(xc.swift).toEqual(['-DSWIFTY']);
    expect(xc.includes).toEqual([path.join(root, 'cpp'), path.join(root, 'lib')]);
    expect(warnings.some((w) => w.includes('Headers/Private/React-Core'))).toBe(true);
  });
});

describe('convertSpec', () => {
  // A mixed pod shaped like `expo`: Swift + ObjC, one .m needs the generated Swift header, a private
  // header that imports it too.
  const mixed = {
    'Mixed.podspec': '',
    'package.json': '{}',
    'ios/Module.swift': 'public class M {}',
    'ios/Core/MXThing.h': '#import <Foundation/Foundation.h>',
    'ios/Core/MXThing.m': '#import <Mixed/MXThing.h>\n#import "MXPrivate.h"',
    'ios/Core/MXPrivate.h': '#pragma once',
    'ios/Loader/MXLoader.h': '',
    'ios/Loader/MXLoader.m': '#import <Mixed/MXLoader.h>\n#if __has_include(<Mixed/Mixed-Swift.h>)\n#import <Mixed/Mixed-Swift.h>\n#else\n#import "Mixed-Swift.h"\n#endif',
    'ios/Swift.h': '#import "Mixed-Swift.h"',
    'ios/Bridge/MXBridge.mm': '#import "Swift.h"',
    'ios/Tests/MXTests.swift': '',
  };

  test('swift / objc / objc_late split with headers under the header dir', () => {
    const root = fixture(mixed);
    const { product, warnings } = convertSpec(
      spec('Mixed', {
        header_dir: 'Mixed',
        source_files: ['ios/**/*.{h,m,mm,swift}'],
        private_header_files: ['ios/**/Swift.h', 'ios/Core/MXPrivate.h'],
        dependencies: { ExpoModulesCore: [], 'React-Core': [], RNScreens: [] },
        compiler_flags: ['-DFOLLY_MOBILE=1 -Wno-comma'],
        frameworks: ['UIKit'],
        resource_bundles: { MixedBundle: ['ios/*.xcprivacy'] },
        platforms: { ios: '16.4', osx: '13.4' },
        swift_versions: ['5.9'],
      }),
      { podspecDir: root, packageRoot: root, packageName: 'mixed' },
    );
    expect(product.name).toBe('Mixed');
    expect(product.podName).toBe('Mixed');
    expect(product.platforms).toEqual(['iOS("16.4")']);
    expect(product.swiftLanguageVersions).toEqual(['5.9']);
    const deps = ['Hermes', 'React', 'ReactNativeDependencies', 'expo-modules-core/ExpoModulesCore', 'pod:RNScreens'];
    expect(product.externalDependencies).toEqual(deps);
    expect(product.targets.map((t) => t.name)).toEqual(['Mixed', 'Mixed_objc', 'Mixed_objc_late']);

    const swift = byName(product.targets, 'Mixed');
    expect(swift).toMatchObject({ type: 'swift', path: 'ios', files: ['Module.swift'], dependencies: [...deps, 'Mixed_objc'] });
    expect(swift.compilerFlags).toBeUndefined(); // s.compiler_flags never reach Swift
    expect(swift.resourceBundles).toEqual({ MixedBundle: ['ios/*.xcprivacy'] });

    const objc = byName(product.targets, 'Mixed_objc');
    expect(objc).toMatchObject({ type: 'objc', moduleName: 'Mixed', path: 'ios', dependencies: deps, linkedFrameworks: ['UIKit'] });
    expect(objc.files).toEqual(['Core/MXThing.m']);
    expect(objc.headers).toEqual(['Core/MXThing.h', 'Loader/MXLoader.h']);
    expect(objc.compilerFlags).toEqual(['-DFOLLY_MOBILE=1', '-Wno-comma']);
    expect(objc.includeDirectories).toEqual(['Core']); // MXPrivate.h is private: reached in the tree

    const late = byName(product.targets, 'Mixed_objc_late');
    expect(late.importsSwiftHeaderOf).toBe('Mixed');
    expect(late.dependencies).toEqual([...deps, 'Mixed', 'Mixed_objc']);
    // MXLoader.m imports Mixed-Swift.h directly; MXBridge.mm through the private Swift.h.
    expect(late.files).toEqual(['Bridge/MXBridge.mm', 'Loader/MXLoader.m']);
    expect(late.path).toBe('ios');
    expect(late.includeDirectories).toEqual(['.']); // for "Swift.h"
    expect(warnings.filter((w) => !w.includes('non-source'))).toEqual([]);
  });

  test('pure ObjC pod: one target named like the module; module name from header_dir', () => {
    const root = fixture({ 'ios/RNThing.h': '', 'ios/RNThing.mm': '#import "RNThing.h"', 'ios/util.c': '' });
    const { product } = convertSpec(spec('react-native-thing', { header_dir: 'RNThing', source_files: ['ios/**/*.{h,m,mm,c}'], rn_deps: true }), {
      podspecDir: root,
      packageRoot: root,
      packageName: 'react-native-thing',
    });
    expect(product.name).toBe('RNThing');
    expect(product.targets).toEqual([
      {
        type: 'objc', name: 'RNThing', moduleName: 'RNThing', path: 'ios',
        files: ['RNThing.mm', 'util.c'], headers: ['RNThing.h'],
        dependencies: ['Hermes', 'React', 'ReactNativeDependencies'],
      },
    ]);
  });

  test('C++-only sources give a cpp target; paths are relative to the package root', () => {
    const root = fixture({ 'ios/a.cpp': '', 'ios/a.h': '' });
    const { product } = convertSpec(spec('Cxx', { source_files: ['*.{h,cpp}'] }), {
      podspecDir: path.join(root, 'ios'),
      packageRoot: root,
      packageName: 'cxx',
    });
    expect(byName(product.targets, 'Cxx')).toMatchObject({ type: 'cpp', path: 'ios', files: ['a.cpp'], headers: ['a.h'] });
  });

  test('subspecs: defaults merged, own-subspec deps followed, flagged subspec becomes its own target', () => {
    const root = fixture({
      'ios/Main.swift': '', 'ios/Dev.h': '', 'ios/Dev.m': '',
      'ios/Unsafe/U.m': '#import <Dev/Dev.h>', 'ios/Extra/E.m': '',
    });
    const unsafe = spec('Unsafe', { source_files: ['ios/Unsafe/**/*.m'], compiler_flags: ['-fno-objc-arc'] });
    const mainSub = spec('Main', { dependencies: { 'dev-pod/Unsafe': [], EXManifests: [] } });
    const extra = spec('Extra', { source_files: ['ios/Extra/*.m'] });
    const root_ = spec('dev-pod', {
      header_dir: 'Dev',
      source_files: ['ios/**/*.{h,m,swift}'],
      exclude_files: ['ios/Unsafe/**', 'ios/Extra/**'],
      subspecs: [unsafe, mainSub, extra],
      default_subspecs: ['Main'],
    });
    const { product, warnings } = convertSpec(root_, { podspecDir: root, packageRoot: root, packageName: 'dev-pod' });
    expect(product.name).toBe('Dev');
    expect(product.targets.map((t) => t.name)).toEqual(['Dev', 'Dev_objc', 'Dev_Unsafe']);
    expect(byName(product.targets, 'Dev_Unsafe')).toMatchObject({
      files: ['U.m'],
      compilerFlags: ['-fno-objc-arc'],
      dependencies: ['pod:EXManifests', 'Dev_objc'],
    });
    expect(byName(product.targets, 'Dev_objc').files).toEqual(['Dev.m']);
    expect(warnings).toContain('non-default subspecs left out (need an override if the app uses them): dev-pod/Extra');
  });

  test('vendored frameworks become framework targets and dependencies', () => {
    const root = fixture({ 'Frameworks/Foo.xcframework/Info.plist': '', 'ios/A.swift': '' });
    const { product, warnings } = convertSpec(
      spec('Vend', { source_files: ['ios/*.swift'], vendored_frameworks: ['Frameworks/*.xcframework'], script_phases: [{ name: 'gen', script: 'x', execution_position: null }] }),
      { podspecDir: root, packageRoot: root, packageName: 'vend' },
    );
    expect(byName(product.targets, 'Foo')).toEqual({ type: 'framework', name: 'Foo', path: 'Frameworks/Foo.xcframework' });
    expect(byName(product.targets, 'Vend').dependencies).toEqual(['Foo']);
    expect(warnings.some((w) => w.startsWith("script phase 'gen'"))).toBe(true);
  });
});

const ruby = Bun.which('ruby');
describe.skipIf(!ruby)('eval.rb end to end', () => {
  test('stub DSL: helpers, platform proxies, xcframework branch, subspecs, test specs', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'demo-pkg', version: '1.2.3', codegenConfig: { name: 'DemoSpec' } }),
      'ios/Demo.swift': '',
      'ios/DMHelper.h': '',
      'ios/DMHelper.m': '#import "DMHelper.h"',
      'ios/Tests/DemoTests.swift': '',
      'Demo.podspec': `
require 'json'
require 'colored2'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
folly = get_folly_config()[:compiler_flags]
Pod::Spec.new do |s|
  s.name = 'Demo'
  s.version = package['version']
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.source = { :git => "x", :tag => "#{s.version}" }
  s.header_dir = 'Demo'
  s.dependency 'ExpoModulesCore'
  add_dependency(s, 'React-jsinspector', :framework_name => 'jsinspector_modern')
  if !$ExpoUseSources&.include?(package['name']) && ENV['EXPO_USE_SOURCE'].to_i == 0 && File.exist?("#{s.name}.xcframework")
    s.vendored_frameworks = "#{s.name}.xcframework"
  else
    s.source_files = 'ios/**/*.{h,m,swift}'
  end
  s.ios.frameworks = 'AVFoundation', 'UIKit'
  s.osx.frameworks = 'AppKit'
  s.compiler_flags = folly
  s.pod_target_xcconfig = { 'OTHER_SWIFT_FLAGS' => "$(inherited) #{ENV['RCT_NEW_ARCH_ENABLED'] == '1' ? '-DNEW_ARCH' : ''}" }
  Pod::UI.puts "chatter".yellow if defined?(use_expo_modules!)
  puts "more chatter"
  s.mystery_attribute = 1
  install_modules_dependencies(s)
  s.test_spec 'Tests' do |t|
    t.source_files = 'ios/Tests/**/*.swift'
    t.dependency 'Quick'
  end
end
`,
    });
    const res = await convertPodspec(path.join(root, 'Demo.podspec'), { packageRoot: root, packageName: 'demo-pkg', projectRoot: root });
    expect(res.codegen).toBe(true);
    const p = res.config.products[0];
    expect(p?.name).toBe('Demo');
    expect(p?.codegenName).toBe('DemoSpec');
    expect(p?.platforms).toEqual(['iOS("15.1")']);
    expect(p?.targets.map((t) => t.name)).toEqual(['Demo', 'Demo_objc']);
    const swift = p ? byName(p.targets, 'Demo') : undefined;
    expect(swift?.files).toEqual(['Demo.swift']);
    expect(swift?.swiftFlags).toEqual(['-DNEW_ARCH']);
    expect(swift?.linkedFrameworks).toEqual(['AVFoundation', 'UIKit']);
    expect(p?.externalDependencies).toEqual(['Hermes', 'React', 'ReactNativeDependencies', 'expo-modules-core/ExpoModulesCore']);
    const objc = p ? byName(p.targets, 'Demo_objc') : undefined;
    expect(objc?.compilerFlags).toContain('-DFOLLY_MOBILE=1');
    expect(res.warnings).toContain('unknown spec attribute Demo.mystery_attribute');
  });
});
