// Type-checking the edge functions with tsc (the Deno runtime provides the real global).
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};
