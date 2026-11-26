/// <reference types="vite/client" />
// Files with more than one dot (like this one and *.test.ts) are not deployed by Convex.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.ts", "!./test.*"]);
