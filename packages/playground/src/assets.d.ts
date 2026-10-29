// Files imported for their URL, which the bundler copies beside the page.
declare module "*.bin" {
  const url: string;
  export default url;
}
