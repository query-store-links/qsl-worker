declare module "*.wasm" {
  const m: WebAssembly.Module;
  export default m;
}
