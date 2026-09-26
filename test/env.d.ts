declare module "cloudflare:test" {
  // Give `env` in tests the wrangler-generated Env type (including the merged secrets declaration).
  interface ProvidedEnv extends Env {}
}
