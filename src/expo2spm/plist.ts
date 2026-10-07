// Minimal XML property list writer for Info.plist / entitlements (values from `expo config`).
import { z } from 'zod';

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

export const plistValue: z.ZodType<PlistValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(plistValue), z.record(z.string(), plistValue)]),
);
export const plistDict = z.record(z.string(), plistValue);
export type PlistDict = z.infer<typeof plistDict>;

const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function render(v: PlistValue, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return `${indent}<${v}/>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    return `${indent}<array>\n${v.map((x) => render(x, `${indent}  `)).join('\n')}\n${indent}</array>`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return `${indent}<dict/>`;
  const body = keys.map((k) => {
    const child = v[k];
    return child === undefined ? '' : `${indent}  <key>${esc(k)}</key>\n${render(child, `${indent}  `)}`;
  });
  return `${indent}<dict>\n${body.filter(Boolean).join('\n')}\n${indent}</dict>`;
}

export function toPlist(dict: PlistDict): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${render(dict, '')}
</plist>
`;
}

/** Replace $(VAR) / ${VAR} build-setting references in every string. Unknown vars are left as-is. */
export function substitute(v: PlistValue, vars: Readonly<Record<string, string>>): PlistValue {
  if (typeof v === 'string') return v.replace(/\$[({]([A-Za-z0-9_]+)(?::[^)}]*)?[)}]/g, (m, name: string) => vars[name] ?? m);
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}
