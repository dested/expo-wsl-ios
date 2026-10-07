// What the Windows-side prep step hands the generator: autolinking output, parsed at the boundary.
import { z } from 'zod';

/** `expo-modules-autolinking resolve --platform apple --json` */
export const expoResolve = z.object({
  modules: z.array(
    z.object({
      packageName: z.string(),
      packageVersion: z.string(),
      pods: z.array(z.object({ podName: z.string(), podspecDir: z.string() })),
      swiftModuleNames: z.array(z.string()).optional(),
      debugOnly: z.boolean().optional(),
    }),
  ),
});
export type ExpoResolve = z.infer<typeof expoResolve>;

/** `expo-modules-autolinking react-native-config --platform ios --json` */
export const rnConfig = z.object({
  reactNativePath: z.string().optional(),
  dependencies: z.record(
    z.string(),
    z.object({
      root: z.string(),
      name: z.string(),
      platforms: z.object({
        ios: z
          .object({
            podspecPath: z.string(),
            version: z.string().optional(),
            scriptPhases: z.array(z.unknown()).optional(),
          })
          .nullable()
          .optional(),
      }),
    }),
  ),
});
export type RnConfig = z.infer<typeof rnConfig>;

/** G:\code\x -> /mnt/g/code/x; POSIX paths pass through. */
export function toPosixPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replaceAll('\\', '/');
  const [, drive = '', rest = ''] = m;
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`;
}
