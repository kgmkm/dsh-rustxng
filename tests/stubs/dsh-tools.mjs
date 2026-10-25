/**
 * Stub of `@deepseek-ai/dsh-tools` for tests that run outside a Harness process.
 *
 * `defineTool` only normalizes a definition object in the real package, so echoing the
 * definition is enough to check the tool wiring (names, parameters, execute functions).
 */
export function defineTool(definition) {
  return { ...definition };
}

export default { defineTool };
