// Minimal Deno globals, so the Edge Functions in this repository can be type-checked with
// the repo's own TypeScript (`npm run check:functions`) on a machine that does not have
// Supabase's Deno runtime installed. Supabase's CLI provides the real declarations at
// deploy time; this file is never imported by a function and never runs.
declare namespace Deno {
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
  const env: { get(name: string): string | undefined };
}
