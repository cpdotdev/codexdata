declare module "cloudflare:test" {
  // Give `env` in tests the wrangler-generated Env type (including the merged secrets declaration).
  interface ProvidedEnv extends Env {}
}

// Vite `?raw` imports: the file's exact text (tests that need the committed bytes, not parsed JSON).
declare module "*?raw" {
  const content: string;
  export default content;
}
