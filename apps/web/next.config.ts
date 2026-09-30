import type { NextConfig } from 'next';

// PAGER_API_URL is read at runtime, on the console's server only. It is deliberately
// not listed under `env`: that would bake the build machine's value into the bundle,
// and a console built once would call whichever API was set when it was built.
const config: NextConfig = {};

export default config;
