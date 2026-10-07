#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/cli/index.ts
import { resolve as resolve2 } from "node:path";
import { parseArgs } from "node:util";

// src/cli/doctor.ts
import { existsSync as existsSync3, readFileSync } from "node:fs";
import { join as join3 } from "node:path";
import { z as z2 } from "zod";

// src/cli/env.ts
import { existsSync as existsSync2, realpathSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// src/cli/proc.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

class CommandError extends Error {
  command;
  code;
  stdout;
  stderr;
  constructor(command, code, stdout, stderr) {
    super(`${command} exited ${code ?? "by signal"}
${stderr.slice(-4000)}${stdout ? `
${stdout.slice(-2000)}` : ""}`);
    this.command = command;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts.cwd === undefined ? {} : { cwd: opts.cwd },
      env: { ...process.env, ...opts.env },
      windowsHide: true
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0)
        reject(new CommandError([cmd, ...args].join(" "), code, stdout, stderr));
      else {
        if (!opts.quiet && stderr.trim())
          process.stderr.write(stderr);
        resolve(stdout);
      }
    });
  });
}
function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts.cwd === undefined ? {} : { cwd: opts.cwd },
      env: { ...process.env, ...opts.env },
      stdio: opts.relay ? ["inherit", "pipe", "pipe"] : "inherit"
    });
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new CommandError([cmd, ...args].join(" "), code, "", "")));
  });
}
async function succeeds(cmd, args, opts = {}) {
  try {
    await run(cmd, args, { ...opts, quiet: true });
    return true;
  } catch {
    return false;
  }
}
function which(name) {
  for (const dir of (process.env["PATH"] ?? "").split(";")) {
    if (!dir)
      continue;
    for (const ext of [".exe", ".cmd", ""]) {
      const f = join(dir, name + ext);
      if (existsSync(f))
        return f;
    }
  }
  return;
}
function step(msg) {
  console.log(`\x1B[36m==\x1B[0m ${msg}`);
}

// src/cli/env.ts
var here = dirname(fileURLToPath(import.meta.url));
var PKG_ROOT = basename(here) === "dist" ? resolve(here, "..") : resolve(here, "../..");
var DISTRO = process.env["EXPO_WSL_IOS_DISTRO"] ?? "expo-wsl-ios";
var ROOTFS_URL = process.env["EXPO_WSL_IOS_ROOTFS_URL"] ?? "https://github.com/dested/expo-wsl-ios/releases/download/rootfs-1/expo-wsl-ios-rootfs-1.tar.gz";
function toPosixPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m)
    return p.replaceAll("\\", "/");
  const [, drive = "", rest = ""] = m;
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}
function cpuCap() {
  const n = Number(process.env["EXPO_WSL_IOS_CPUS"] ?? 6);
  return Number.isInteger(n) && n > 0 ? n : 6;
}
var wslEnv = { WSL_UTF8: "1" };
function capped(cmd) {
  return ["-d", DISTRO, "--exec", "taskset", "-c", `0-${cpuCap() - 1}`, "nice", "-n", "10", ...cmd];
}
function wsl(cmd, quiet = true) {
  return run("wsl.exe", capped(cmd), { env: wslEnv, quiet });
}
function wslInherit(cmd) {
  return runInherit("wsl.exe", capped(cmd), { env: wslEnv, relay: true });
}
function wslBash(script, quiet = true) {
  return wsl(["bash", "-c", `export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; ${script}`], quiet);
}
function wslHas(kind, homeRel) {
  return succeeds("wsl.exe", ["-d", DISTRO, "--exec", "bash", "-c", `test -${kind} "$HOME/${homeRel}"`], { env: wslEnv });
}
async function distroExists() {
  try {
    const out = await run("wsl.exe", ["--list", "--quiet"], { env: wslEnv, quiet: true });
    return out.split(/\r?\n/).map((l) => l.trim()).includes(DISTRO);
  } catch {
    return false;
  }
}
function usbmuxdUp() {
  return new Promise((resolve2) => {
    const s = connect({ host: "127.0.0.1", port: 27015, timeout: 1500 });
    const done = (ok) => {
      s.destroy();
      resolve2(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}
function pymobiledevice3() {
  const env = process.env["EXPO_WSL_IOS_PMD"];
  if (env && existsSync2(env))
    return env;
  const uvBin = join2(process.env["USERPROFILE"] ?? "", ".local", "bin", "pymobiledevice3.exe");
  return which("pymobiledevice3") ?? (existsSync2(uvBin) ? uvBin : undefined);
}
var usbmuxList = z.array(z.object({ UniqueDeviceID: z.string(), DeviceName: z.string().optional() }));
async function usbDevices(pmd) {
  return usbmuxList.parse(JSON.parse(await run(pmd, ["usbmux", "list", "--usb"], { quiet: true })));
}
function packageDir(name, from) {
  for (let dir = realpathSync(from);; ) {
    const candidate = join2(dir, "node_modules", name);
    if (existsSync2(join2(candidate, "package.json")))
      return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`cannot find package ${name} from ${from} (is node_modules installed?)`);
    dir = parent;
  }
}
var binField = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]).optional() });
async function binPath(pkgDir, bin) {
  const { readFile } = await import("node:fs/promises");
  const pj = binField.parse(JSON.parse(await readFile(join2(pkgDir, "package.json"), "utf8")));
  const rel = typeof pj.bin === "string" ? pj.bin : pj.bin?.[bin];
  if (!rel)
    throw new Error(`${pkgDir}: no bin "${bin}"`);
  return join2(pkgDir, rel);
}

// src/cli/doctor.ts
var version = z2.object({ version: z2.string() });
async function doctor(app) {
  const checks = [];
  const add = (name, ok, fix) => {
    checks.push(fix === undefined ? { name, ok } : { name, ok, fix });
  };
  const hasWsl = await succeeds("wsl.exe", ["--version"]);
  add("WSL 2", hasWsl, "wsl --install --no-distribution (admin), then reboot");
  const hasDistro = hasWsl && await distroExists();
  add(`WSL distro "${DISTRO}"`, hasDistro, "npx expo-wsl-ios setup");
  if (hasDistro) {
    const tools = await wslBash('for t in swift xtool bun ruby rsync rcodesign taskset; do command -v $t >/dev/null || echo "$t"; done').catch(() => "unreachable");
    add("toolchain in the distro (swift, xtool, bun, ruby, rsync, rcodesign)", tools.trim() === "", `missing: ${tools.trim()}; re-import the distro (wsl --unregister ${DISTRO}, then setup)`);
    add("iOS SDK (from Xcode.xip)", await wslHas("d", ".swiftpm/swift-sdks/darwin.artifactbundle"), "npx expo-wsl-ios setup --xip <Xcode_27.xip>");
    add("App Store Connect API key", await wslHas("f", ".config/expo-wsl-ios/asc.env"), "npx expo-wsl-ios setup --asc-key <AuthKey_XXXX.p8> --issuer-id <uuid>");
  }
  add("Apple device driver (usbmuxd)", await usbmuxdUp(), 'install "Apple Devices" from the Microsoft Store and open it once');
  const pmd = pymobiledevice3();
  add("pymobiledevice3", pmd !== undefined, "uv tool install pymobiledevice3");
  if (pmd) {
    const devices = await usbDevices(pmd).catch(() => []);
    add(`iPhone on USB${devices[0] ? `: ${devices[0].DeviceName ?? devices[0].UniqueDeviceID}` : ""}`, devices.length > 0, "plug it in, unlock it, tap Trust");
  }
  if (existsSync3(join3(app, "package.json"))) {
    try {
      const expo = version.parse(JSON.parse(readFileSync(join3(packageDir("expo", app), "package.json"), "utf8"))).version;
      const major = Number(expo.split(".")[0]);
      add(`Expo SDK ${major}`, major >= 57, "expo-wsl-ios needs Expo SDK 57+ (the SwiftPM configs it builds from)");
    } catch {
      add("Expo project", false, "run doctor inside an Expo project with node_modules installed");
    }
  }
  for (const c of checks)
    console.log(`${c.ok ? "\x1B[32m✓\x1B[0m" : "\x1B[31m✗\x1B[0m"} ${c.name}${c.ok || !c.fix ? "" : `
    fix: ${c.fix}`}`);
  console.log(`
WSL builds run on ${cpuCap()} vCPUs at low priority (EXPO_WSL_IOS_CPUS to change).`);
  return checks.every((c) => c.ok);
}

// src/cli/run.ts
import { join as join5 } from "node:path";

// src/cli/prep.ts
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, userInfo } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";
import { z as z3 } from "zod";
var appConfig = z3.object({
  name: z3.string(),
  slug: z3.string(),
  ios: z3.object({ bundleIdentifier: z3.string().optional() }).optional()
});
function lanAddress() {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|Loopback|VirtualBox|VMware|Tailscale|ZeroTier/i.test(name))
      continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
        return a.address;
    }
  }
  throw new Error("no LAN address found; pass --host <ip of this PC on the phone's Wi-Fi>");
}
function metroPortFromScripts(app) {
  const pj = z3.object({ scripts: z3.record(z3.string(), z3.string()).optional() }).parse(JSON.parse(readFileSync2(join4(app, "package.json"), "utf8")));
  const m = /--port[ =](\d+)/.exec(pj.scripts?.["start"] ?? "");
  return m?.[1] ? Number(m[1]) : undefined;
}
function productNameFor(slug) {
  const pascal = slug.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _s, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
  return /^[0-9]/.test(pascal) ? `App${pascal}` : pascal || "App";
}
async function prep(o) {
  const app = o.app;
  const dir = join4(app, ".expo", "wsl-ios", "prep");
  const node = (args, cwd = app) => run(process.execPath, args, { cwd, quiet: true });
  const expoDir = packageDir("expo", app);
  const rnDir = packageDir("react-native", app);
  const autolinking = await binPath(packageDir("expo-modules-autolinking", expoDir), "expo-modules-autolinking");
  const expoCli = await binPath(expoDir, "expo");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  step("autolinking");
  writeFileSync(join4(dir, "expo-resolve.json"), await node([autolinking, "resolve", "--platform", "apple", "--json"]));
  writeFileSync(join4(dir, "rn-config.json"), await node([autolinking, "react-native-config", "--platform", "ios", "--json"]));
  step("codegen (app)");
  await node([join4(rnDir, "scripts/generate-codegen-artifacts.js"), "-p", app, "-t", "ios", "-o", join4(dir, "codegen")]);
  step("codegen (libraries that compile their own codegen)");
  const resolveJson = z3.object({ modules: z3.array(z3.object({ packageName: z3.string(), pods: z3.array(z3.object({ podspecDir: z3.string() })) })) }).parse(JSON.parse(readFileSync2(join4(dir, "expo-resolve.json"), "utf8")));
  const moduleRoot = (pkg) => {
    const podspecDir = resolveJson.modules.find((m) => m.packageName === pkg)?.pods[0]?.podspecDir;
    for (let d = podspecDir;d !== undefined && dirname2(d) !== d; d = dirname2(d)) {
      if (existsSync4(join4(d, "expo-module.config.json")) || existsSync4(join4(d, "package.json")))
        return d;
    }
    return packageDir(pkg, app);
  };
  const rnJson = z3.object({ dependencies: z3.record(z3.string(), z3.unknown()) }).parse(JSON.parse(readFileSync2(join4(dir, "rn-config.json"), "utf8")));
  const packages = new Set([...resolveJson.modules.map((m) => m.packageName), ...Object.keys(rnJson.dependencies)]);
  for (const pkg of packages) {
    if (o.exclude.includes(pkg))
      continue;
    const pkgDir = moduleRoot(pkg);
    const configs = [
      join4(app, "expo-wsl-ios/configs", pkg, "spm.config.json"),
      join4(PKG_ROOT, "configs", pkg, "spm.config.json"),
      join4(pkgDir, "spm.config.json"),
      join4(packageDir("expo-modules-autolinking", expoDir), "external-configs/ios", pkg, "spm.config.json")
    ];
    const config = configs.find((f) => existsSync4(f));
    if (config && readFileSync2(config, "utf8").includes(".build/codegen")) {
      await node([join4(rnDir, "scripts/generate-codegen-artifacts.js"), "-p", pkgDir, "-t", "ios", "-o", join4(dir, "libs", pkg, "codegen"), "-s", "library"], rnDir);
    }
  }
  step("ExpoModulesProvider.swift");
  const expoPackages = resolveJson.modules.map((m) => m.packageName).filter((p) => !o.exclude.includes(p));
  await node([autolinking, "generate-modules-provider", "--platform", "apple", "--target", join4(dir, "ExpoModulesProvider.swift"), "--packages", ...expoPackages]);
  step("app config");
  const introspect = await node([expoCli, "config", "--type", "introspect", "--json"]);
  writeFileSync(join4(dir, "introspect.json"), introspect);
  const cfg = appConfig.parse(JSON.parse(introspect));
  let bundleId = o.bundleId ?? cfg.ios?.bundleIdentifier;
  if (!bundleId) {
    const part = (s) => s.toLowerCase().replace(/[^a-z0-9-]/g, "") || "app";
    bundleId = `com.${part(userInfo().username)}.${part(cfg.slug)}`;
    console.log(`   no expo.ios.bundleIdentifier: using ${bundleId} (set it in app.json to keep it stable)`);
  }
  const constants = join4(packageDir("expo-constants", expoDir), "scripts/getAppConfig.js");
  if (existsSync4(constants)) {
    mkdirSync(join4(dir, "EXConstants.bundle"), { recursive: true });
    await node([constants, app, join4(dir, "EXConstants.bundle")]);
  }
  step("JS bundle + Hermes bytecode (embedded fallback when Metro is not running)");
  const entry = (await node(["-e", `process.stdout.write(require(require.resolve('@expo/config/paths',{paths:[${JSON.stringify(expoDir)}]})).resolveEntryPoint(process.cwd(),{platform:'ios'}))`])).trim();
  await node([
    expoCli,
    "export:embed",
    "--platform",
    "ios",
    "--dev",
    "false",
    "--minify",
    "true",
    "--entry-file",
    entry,
    "--bundle-output",
    join4(dir, "main.jsbundle"),
    "--assets-dest",
    join4(dir, "assets")
  ]).catch((e) => {
    const crashedAfterWrite = e instanceof CommandError && e.code === 3221225477 && e.stdout.includes("Done writing bundle output");
    if (!crashedAfterWrite)
      throw e;
    console.log("   node crashed after Metro finished writing (a Windows Node flake); keeping the bundle");
  });
  const hermesc = join4(packageDir("hermes-compiler", rnDir), "hermesc/win64-bin/hermesc.exe");
  await run(hermesc, ["-emit-binary", "-O", "-max-diagnostic-width=80", "-w", "-out", join4(dir, "main.hbc"), join4(dir, "main.jsbundle")], { quiet: true });
  const host = o.host ?? lanAddress();
  const port = o.port ?? metroPortFromScripts(app) ?? 8081;
  writeFileSync(join4(dir, "ip.txt"), `${host}:${port}
`);
  writeFileSync(join4(dir, "metro-port"), String(port));
  return { dir, name: cfg.name, slug: cfg.slug, bundleId, productName: productNameFor(cfg.slug), metro: `${host}:${port}` };
}

// src/cli/run.ts
var DEFAULT_EXCLUDE = ["expo-dev-client", "expo-dev-launcher", "expo-dev-menu", "expo-dev-menu-interface", "@expo/dom-webview", "@expo/log-box"];
async function pickDevice(pmd, udid) {
  const devices = await usbDevices(pmd);
  if (udid)
    return devices.find((d) => d.UniqueDeviceID === udid) ?? { UniqueDeviceID: udid };
  const [first, ...rest] = devices;
  if (!first)
    throw new Error("no iPhone on USB: plug it in, unlock it, tap Trust (or pass --udid to build without one)");
  if (rest.length)
    throw new Error(`several devices connected; pass --udid (${devices.map((d) => `${d.DeviceName ?? "?"} ${d.UniqueDeviceID}`).join(", ")})`);
  return first;
}
async function runCommand(o) {
  const t0 = performance.now();
  const pmd = pymobiledevice3();
  if (!pmd)
    throw new Error("pymobiledevice3 not found: `uv tool install pymobiledevice3` (or set EXPO_WSL_IOS_PMD)");
  const device = await pickDevice(pmd, o.udid);
  console.log(`   device: ${device.DeviceName ?? "?"} (${device.UniqueDeviceID})`);
  const p = await prep({ app: o.app, exclude: o.exclude, host: o.host, port: o.port, bundleId: o.bundleId });
  const ipa = join5(o.app, ".expo", "wsl-ios", `${p.productName}.ipa`);
  step("generate + build + sign in WSL");
  await wslInherit([
    "bash",
    toPosixPath(join5(PKG_ROOT, "scripts/wsl-build.sh")),
    toPosixPath(o.app),
    toPosixPath(p.dir),
    p.productName,
    p.bundleId,
    device.UniqueDeviceID,
    o.exclude.join(","),
    toPosixPath(ipa)
  ]);
  if (o.install) {
    step("install");
    await run(pmd, ["apps", "install", ipa], { quiet: true });
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`
${o.install ? "Installed" : "Built"} ${p.name} in ${secs} s${o.install ? ". Tap it on the phone to launch." : `: ${ipa}`}`);
  console.log(`Live reload: run \`npx expo start --port ${p.metro.split(":")[1] ?? "8081"}\` here, and allow Local Network access when iOS asks.`);
  console.log("Without Metro the app runs the JS bundle embedded at build time.");
}

// src/cli/setup.ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync as existsSync5, mkdirSync as mkdirSync2, renameSync, statSync } from "node:fs";
import { basename as basename2, join as join6 } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
var stateDir = () => process.env["EXPO_WSL_IOS_HOME"] ?? join6(process.env["LOCALAPPDATA"] ?? join6(process.env["USERPROFILE"] ?? ".", "AppData/Local"), "expo-wsl-ios");
async function fetchOk(url) {
  const res = await fetch(url);
  if (res.status === 404)
    return;
  if (!res.ok || !res.body)
    throw new Error(`download ${url}: ${res.status}`);
  return res;
}
async function streamTo(res, out, label) {
  if (!res.body)
    throw new Error(`download ${res.url}: empty body`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    got += value.length;
    if (!out.write(value))
      await once(out, "drain");
    if (total && got - last > total / 50) {
      last = got;
      process.stdout.write(`\r   ${label}${(got / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`);
    }
  }
  process.stdout.write(`
`);
}
async function download(url, dest) {
  const out = createWriteStream(`${dest}.part`);
  const whole = await fetchOk(url);
  if (whole)
    await streamTo(whole, out, "");
  else {
    for (let i = 1;; i++) {
      const part = await fetchOk(`${url}.part${i}`);
      if (!part) {
        if (i === 1)
          throw new Error(`download ${url}: not found (nor ${url}.part1)`);
        break;
      }
      await streamTo(part, out, `part ${i}: `);
    }
  }
  await new Promise((resolve2, reject) => out.end((e) => e ? reject(e) : resolve2()));
  renameSync(`${dest}.part`, dest);
}
async function sha256(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}
async function ensureDistro(o) {
  if (await distroExists()) {
    console.log(`   WSL distro "${DISTRO}" already exists`);
    return;
  }
  let tar = o.rootfs;
  if (!tar || /^https?:/.test(tar)) {
    const url = tar ?? ROOTFS_URL;
    mkdirSync2(stateDir(), { recursive: true });
    tar = join6(stateDir(), basename2(new URL(url).pathname));
    if (!existsSync5(tar)) {
      console.log(`   downloading ${url}`);
      await download(url, tar);
      const sumRes = await fetch(`${url}.sha256`);
      if (sumRes.ok) {
        const want = (await sumRes.text()).trim().split(/\s+/)[0] ?? "";
        const got = await sha256(tar);
        if (want && want !== got)
          throw new Error(`rootfs checksum mismatch (${got} != ${want}); delete ${tar} and retry`);
        console.log("   checksum ok");
      }
    }
  }
  if (!existsSync5(tar))
    throw new Error(`rootfs not found: ${tar}`);
  const location = o.location ?? join6(stateDir(), "distro");
  mkdirSync2(location, { recursive: true });
  console.log(`   importing ${(statSync(tar).size / 1e9).toFixed(1)} GB into ${location}`);
  await runInherit("wsl.exe", ["--import", DISTRO, location, tar, "--version", "2"]);
}
async function ensureSdk(o) {
  if (await wslHas("d", ".swiftpm/swift-sdks/darwin.artifactbundle")) {
    console.log("   iOS SDK already installed");
    return;
  }
  if (!o.xip) {
    throw new Error("the iOS SDK comes from Xcode.xip: download Xcode 27 from https://developer.apple.com/download/all/ and pass --xip <path>");
  }
  if (!existsSync5(o.xip))
    throw new Error(`no such file: ${o.xip}`);
  console.log("   extracting the SDK from Xcode.xip (several minutes, about 20 GB of temporary space)");
  const sdkStep = () => wslInherit([
    "env",
    `XCODE_XIP=${toPosixPath(o.xip ?? "")}`,
    "bash",
    "-c",
    'export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"; ulimit -n 65536; rm -rf ~/.cache/xtool/.build.* ~/.cache/xtool/pid-*; cd ~/omarchy-apple-dev && ./install-toolchain.sh --repair'
  ]);
  try {
    await sdkStep();
  } catch (e) {
    if (!(e instanceof CommandError) || e.code !== 139)
      throw e;
    console.log("   xtool crashed at startup (a known flake); retrying once");
    await sdkStep();
  }
}
async function ensureAscKey(o) {
  const have = await wslHas("f", ".config/expo-wsl-ios/asc.env");
  if (!o.ascKey) {
    if (have)
      console.log("   App Store Connect key already configured");
    else
      throw new Error("signing needs an App Store Connect API key: pass --asc-key <AuthKey_XXXX.p8> --issuer-id <uuid> (App Store Connect > Users and Access > Integrations)");
    return;
  }
  if (!existsSync5(o.ascKey))
    throw new Error(`no such file: ${o.ascKey}`);
  const keyId = o.keyId ?? /AuthKey_([A-Z0-9]+)\.p8$/i.exec(o.ascKey)?.[1];
  if (!keyId)
    throw new Error("pass --key-id (it is also the XXXX in AuthKey_XXXX.p8)");
  if (!o.issuerId)
    throw new Error("pass --issuer-id (App Store Connect > Users and Access > Integrations, above the key list)");
  if (!/^[A-Z0-9]{8,12}$/i.test(keyId) || !/^[0-9a-f-]{36}$/i.test(o.issuerId))
    throw new Error("key id or issuer id looks wrong");
  await wslBash([
    "set -e",
    'd=~/.config/expo-wsl-ios; mkdir -p "$d"; chmod 700 "$d"',
    `install -m600 '${toPosixPath(o.ascKey)}' "$d/AuthKey_${keyId}.p8"`,
    `printf 'ASC_KEY_ID=%s\\nASC_ISSUER_ID=%s\\n' '${keyId}' '${o.issuerId}' > "$d/asc.env"; chmod 600 "$d/asc.env"`
  ].join("; "));
  console.log(`   key ${keyId} stored in the distro (~/.config/expo-wsl-ios)`);
}
async function ensureDeviceTools() {
  if (!await usbmuxdUp()) {
    console.log('   ! Apple device driver not running: install "Apple Devices" from the Microsoft Store, open it once, rerun setup');
  } else {
    console.log("   Apple device driver (usbmuxd) running");
  }
  if (pymobiledevice3()) {
    console.log("   pymobiledevice3 present");
    return;
  }
  const uv = which("uv");
  if (!uv) {
    console.log("   ! pymobiledevice3 missing: install uv (`winget install astral-sh.uv`), then rerun setup");
    return;
  }
  await runInherit(uv, ["tool", "install", "pymobiledevice3"]);
}
async function setup(o) {
  step("WSL");
  if (!await succeeds("wsl.exe", ["--version"])) {
    throw new Error("WSL 2 is not installed: run `wsl --install --no-distribution` in an admin terminal, reboot, rerun setup");
  }
  step(`distro "${DISTRO}"`);
  await ensureDistro(o);
  step("iOS SDK");
  await ensureSdk(o);
  step("signing key");
  await ensureAscKey(o);
  step("device tooling (Windows)");
  await ensureDeviceTools();
  console.log(`
Setup done. On the iPhone: Settings > Privacy & Security > Developer Mode (it shows up after the
first install attempt). Then, in your Expo project: npx expo-wsl-ios run`);
  await run("wsl.exe", ["--terminate", DISTRO], { quiet: true }).catch(() => {
    return;
  });
}

// src/cli/index.ts
var USAGE = `expo-wsl-ios <command> [options]

  setup    One-time machine setup: WSL distro, iOS SDK, signing key, device tooling
           --xip <Xcode.xip>  --asc-key <AuthKey_XXXX.p8>  --issuer-id <uuid>  [--key-id <id>]
           [--rootfs <tar or url>]  [--location <dir for the distro>]
  doctor   Check every prerequisite and print the fix for each failure
  run      Build, sign and install the Expo app in the current directory on the USB iPhone
           [--udid <id>] [--bundle-id <id>] [--exclude a,b] [--host <lan ip>] [--port <metro port>]
           [--no-install]
  prep     Only the Windows-side JS steps (codegen, config, bundle), for debugging

Environment: EXPO_WSL_IOS_CPUS (default 6), EXPO_WSL_IOS_HOME (downloads + distro, default %LOCALAPPDATA%\\expo-wsl-ios),
             EXPO_WSL_IOS_DISTRO, EXPO_WSL_IOS_PMD`;
async function main() {
  if (process.platform !== "win32") {
    console.error("expo-wsl-ios runs on Windows (it drives WSL from the Windows side). On a Mac, use `npx expo run:ios`.");
    return 1;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      xip: { type: "string" },
      "asc-key": { type: "string" },
      "key-id": { type: "string" },
      "issuer-id": { type: "string" },
      rootfs: { type: "string" },
      location: { type: "string" },
      udid: { type: "string" },
      "bundle-id": { type: "string" },
      exclude: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "no-install": { type: "boolean" },
      app: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  const [cmd] = positionals;
  const app = resolve2(values.app ?? positionals[1] ?? process.cwd());
  const exclude = [...DEFAULT_EXCLUDE, ...values.exclude?.split(",").filter(Boolean) ?? []];
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isInteger(port))
    throw new Error("--port must be a number");
  switch (cmd) {
    case "setup":
      await setup({ rootfs: values.rootfs, location: values.location, xip: values.xip, ascKey: values["asc-key"], keyId: values["key-id"], issuerId: values["issuer-id"] });
      return 0;
    case "doctor":
      return await doctor(app) ? 0 : 1;
    case "run":
      await runCommand({ app, exclude, host: values.host, port, bundleId: values["bundle-id"], udid: values.udid, install: values["no-install"] !== true });
      return 0;
    case "prep": {
      const p = await prep({ app, exclude, host: values.host, port, bundleId: values["bundle-id"] });
      console.log(`prep output: ${p.dir}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || values.help === true ? 0 : 1;
  }
}
main().then((code) => process.exit(code), (e) => {
  console.error(`\x1B[31merror:\x1B[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
