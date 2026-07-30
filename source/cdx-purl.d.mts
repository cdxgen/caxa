// @cdxgen/cdx-purl ships without type declarations. Only the `build` entry point
// is used here, so declare the minimum rather than vendoring a full definition.
declare module "@cdxgen/cdx-purl" {
  export function build(parts: {
    type: string;
    namespace?: string | null;
    name: string;
    version?: string | null;
    qualifiers?: Record<string, string> | null;
    subpath?: string | null;
  }): string;
}
