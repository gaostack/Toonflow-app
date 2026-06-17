// Ambient fallback because onnxruntime-web's package.json exports do not expose
// types under bundler/module16 resolution.
declare module "onnxruntime-web" {
  const mod: any;
  export = mod;
}
