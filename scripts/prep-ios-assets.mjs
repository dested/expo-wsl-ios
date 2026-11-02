// Evaluate Expo's iOS prebuild mods in a disposable project root. This lets Expo's
// own icon and splash plugins generate their native assets without touching ios/.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const [appArg, outputArg, bundleIdentifier, expoTemplate] = process.argv.slice(2);
if (!appArg || !outputArg || !expoTemplate) throw new Error('usage: prep-ios-assets.mjs <app> <output> <bundle identifier> <expo template.tgz>');
const app = resolve(appArg);
const output = resolve(outputArg);
const project = join(output, 'mod-project');
const assetOutput = join(output, 'native-assets');
rmSync(project, { recursive: true, force: true });
rmSync(assetOutput, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
mkdirSync(assetOutput, { recursive: true });

const appRequire = createRequire(join(app, 'package.json'));
const { getPrebuildConfigAsync } = appRequire('@expo/prebuild-config');
const { compileModsAsync } = appRequire('@expo/config-plugins');
const loaded = await getPrebuildConfigAsync(app, { platforms: ['ios'], bundleIdentifier });

// Mods resolve config asset paths relative to modRequest.projectRoot. Mirror the
// project's configured files into the disposable root, keeping their relative paths.
const copied = new Set();
const copyConfiguredFiles = (value) => {
  if (typeof value === 'string') {
    const candidate = isAbsolute(value) ? value : resolve(app, value);
    const rel = relative(app, candidate);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || copied.has(rel) || !existsSync(candidate)) return;
    copied.add(rel);
    const dest = join(project, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(candidate, dest, { recursive: true, force: true });
    return;
  }
  if (Array.isArray(value)) value.forEach(copyConfiguredFiles);
  else if (value && typeof value === 'object') Object.values(value).forEach(copyConfiguredFiles);
};
copyConfiguredFiles(loaded.exp);

// Keep package and plugin resolution identical to the source project.
symlinkSync(join(app, 'node_modules'), join(project, 'node_modules'), 'junction');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: loaded.exp.slug ?? 'expo-mod-project', version: '1.0.0' }));

// Base mods and Xcode-project mods expect the normal Expo iOS template files.
// Generate them in this disposable root, never in the user's ios/ directory.
const templateRoot = join(project, '.template-source');
mkdirSync(templateRoot, { recursive: true });
execFileSync('tar', ['-xzf', resolve(expoTemplate), '-C', templateRoot, 'package/ios'], { stdio: 'ignore' });
cpSync(join(templateRoot, 'package/ios'), join(project, 'ios'), { recursive: true, force: true });
rmSync(templateRoot, { recursive: true, force: true });

await compileModsAsync(loaded.exp, {
  projectRoot: project,
  platforms: ['ios'],
  ignoreExistingNativeFiles: true,
});

const findNamed = (root, wanted, results = []) => {
  if (!existsSync(root)) return results;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name === wanted) results.push(path);
    else if (entry.isDirectory()) findNamed(path, wanted, results);
  }
  return results;
};
const iosRoot = join(project, 'ios');
const appIcon = findNamed(iosRoot, 'AppIcon.appiconset')[0];
const catalogs = [...findNamed(iosRoot, 'Images.xcassets'), ...findNamed(iosRoot, 'Assets.xcassets')];
const imagesCatalog = (appIcon && dirname(appIcon)) || catalogs[0];
if (imagesCatalog) cpSync(imagesCatalog, join(assetOutput, 'Assets.xcassets'), { recursive: true, force: true });
const configuredIcon = loaded.exp.ios?.icon ?? loaded.exp.icon;
const hasConfiguredIcon = typeof configuredIcon === 'string'
  ? configuredIcon.length > 0
  : Boolean(configuredIcon && typeof configuredIcon === 'object'
    && (configuredIcon.light || configuredIcon.dark || configuredIcon.tinted));
const plugins = loaded.exp.plugins ?? [];
const hasSplashPlugin = plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-splash-screen');
const storyboards = [];
const findStoryboard = (root) => {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) findStoryboard(path);
    else if (entry.name === 'SplashScreen.storyboard') storyboards.push(path);
  }
};
findStoryboard(iosRoot);
const hasSplashStoryboard = Boolean(storyboards[0] && (hasSplashPlugin || loaded.exp.splash));
if (hasSplashStoryboard) cpSync(storyboards[0], join(assetOutput, 'SplashScreen.storyboard'));

writeFileSync(join(output, 'native-assets.json'), JSON.stringify({
  appIcon: Boolean(appIcon && hasConfiguredIcon),
  splashStoryboard: hasSplashStoryboard,
}));
rmSync(project, { recursive: true, force: true });
