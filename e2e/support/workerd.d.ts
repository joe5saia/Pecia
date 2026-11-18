// The `workerd` package ships no types. Its main module is CommonJS and
// exports the path of the platform's workerd binary as `default`, which an
// ES module import sees as the default export (Vitest) or as its `default`
// property (Node).
declare module "workerd" {
  const workerd: string | { readonly default: string };
  export default workerd;
}
