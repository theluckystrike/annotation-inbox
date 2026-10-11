// Build flag. esbuild.config.mjs defines __PRO_BUILD__ from the environment variable PRO_BUILD ("1" turns it on).
// vitest.config.ts defines it as false. The default is off: the free release has no Pro code, no GitHub host and no sign in.
// Every use is "if (__PRO_BUILD__)" or "__PRO_BUILD__ &&", so esbuild removes the Pro code while it parses, before tree shaking.
declare const __PRO_BUILD__: boolean;
